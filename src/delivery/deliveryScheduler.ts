import { sweepExpired } from "../policies/deliveryPolicy";
import type { OutboxRecord } from "../db/schema";
export type NetMode = "direct" | "tor" | "lokinet" | "onion";
import {
  listRetryableOutbox,
  listInFlightTimedOut,
  listPendingOutbox,
  updateOutbox,
} from "../storage/outboxStore";
import { createId } from "../utils/ids";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { createSafeConsole } from "../diagnostics/safeConsole";

const console = createSafeConsole(globalThis.console);

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean };

export type OutboxSender = (record: OutboxRecord) => Promise<SendResult>;

export type DeliverySchedulerOptions = {
  tickMs?: number;
  batchSize?: number;
  ackTimeoutMs?: number;
  getNetMode?: () => NetMode;
  isOnline?: () => boolean;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
  planDelivery?: (payload: {
    now: number;
    mode: NetMode;
    batchSize: number;
    items: Array<{
      id: string;
      priority: "high" | "normal";
      attempts: number;
      nextAttemptAtMs: number;
      expiresAtMs: number;
      createdAtMs: number;
    }>;
  }) => Promise<{
    selected: Array<{ id: string; attempts: number; nextAttemptAtMs: number }>;
  } | null>;
};

export const createDeliveryScheduler = (
  send: OutboxSender,
  opts: DeliverySchedulerOptions = {}
) => {
  const tickMs = opts.tickMs ?? 1500;
  const batchSize = opts.batchSize ?? 20;
  const ackTimeoutMs = opts.ackTimeoutMs ?? 20_000;
  const getNetMode = opts.getNetMode ?? (() => "direct" as NetMode);
  const isOnline = opts.isOnline ?? (() => true);
  const log = opts.logger ?? console;
  const planDelivery = opts.planDelivery;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const inFlight = new Set<string>();
  const workerId = `delivery-worker:${createId()}`;

  const tick = async () => {
    if (running) return;
    if (!isOnline()) return;

    running = true;
    const now = Date.now();
    try {
      const pending = await listPendingOutbox();
      const dueNow = pending.filter((record) => (record.nextAttemptAtMs ?? now) <= now).length;
      emitFlowTraceLog({
        event: "deliveryWorker:tick",
        workerId,
        queued: pending.length,
        deferred: Math.max(0, pending.length - dueNow),
        dueNow,
        inflight: inFlight.size,
        memQueueLen: inFlight.size,
      });
      await sweepExpired(now);

      const timedOut = await listInFlightTimedOut(now, batchSize);
      for (const rec of timedOut) {
        if (now >= rec.expiresAtMs) continue;
        await updateOutbox(rec.id, {
          status: "pending",
          ackDeadlineMs: undefined,
          inFlightAtMs: undefined,
          nextAttemptAtMs: now,
        });
        emitFlowTraceLog({
          event: "friendRequest:stateChange",
          opId: rec.id,
          from: "in_flight",
          to: "queued",
          why: "ack-timeout",
        });
        log.debug?.(`[delivery] ack timeout -> pending id=${rec.id}`);
      }

      const candidates = await listRetryableOutbox(now, planDelivery ? batchSize * 4 : batchSize);
      const nativePlan = planDelivery
        ? await planDelivery({
            now,
            mode: getNetMode(),
            batchSize,
            items: candidates.map((record) => ({
              id: record.id,
              priority: record.priority ?? "normal",
              attempts: record.attempts ?? 0,
              nextAttemptAtMs: record.nextAttemptAtMs,
              expiresAtMs: record.expiresAtMs,
              createdAtMs: record.createdAtMs,
            })),
          }).catch((error) => {
            log.warn?.("[delivery] native scheduler unavailable", error);
            return null;
          })
        : null;
      if (candidates.length > 0 && !nativePlan) {
        log.warn?.("[delivery] native scheduler unavailable; deferring queued records");
      }
      const plannedById = new Map(nativePlan?.selected.map((item) => [item.id, item]) ?? []);
      const items = nativePlan
        ? nativePlan.selected
            .map((item) => candidates.find((record) => record.id === item.id))
            .filter((record): record is OutboxRecord => Boolean(record))
        : [];
      for (const rec of items) {
        if (inFlight.has(rec.id)) continue;
        if (now >= rec.expiresAtMs) continue;

        const attempts = rec.attempts ?? 0;
        const planned = plannedById.get(rec.id);
        if (!planned) continue;
        inFlight.add(rec.id);
        emitFlowTraceLog({
          event: "deliveryWorker:pickup",
          traceId: rec.id,
          opId: rec.id,
          friendIdHash: rec.convId,
          attempt: attempts + 1,
          retryAtPrev: rec.nextAttemptAtMs ?? null,
        });

        const nextAttempts = planned.attempts;
        const nextAttemptAtMs = planned.nextAttemptAtMs;
        await updateOutbox(rec.id, {
          attempts: nextAttempts,
          lastAttemptAtMs: now,
          nextAttemptAtMs,
        });

        try {
          const result = await send({
            ...rec,
            attempts: nextAttempts,
            lastAttemptAtMs: now,
            nextAttemptAtMs,
          });

          if (result.ok) {
            await updateOutbox(rec.id, {
              status: "in_flight",
              inFlightAtMs: now,
              ackDeadlineMs: now + ackTimeoutMs,
            });
            emitFlowTraceLog({
              event: "friendRequest:stateChange",
              opId: rec.id,
              from: rec.status,
              to: "in_flight",
              why: "send-ok",
            });
            log.debug?.(`[delivery] send ok -> in_flight id=${rec.id}`);
          } else {
            if (!result.retryable) {
              emitFlowTraceLog({
                event: "friendRequest:stateChange",
                opId: rec.id,
                from: rec.status,
                to: rec.status,
                why: "send-failed-non-retryable",
              });
              log.warn?.(`[delivery] non-retryable fail id=${rec.id}`);
            } else {
              emitFlowTraceLog({
                event: "requestSend:deferred",
                opId: rec.id,
                reason: "RETRYABLE_SEND_FAILURE",
                nextRetryAt: nextAttemptAtMs,
                attempt: attempts + 1,
              });
              emitFlowTraceLog({
                event: "retry:scheduled",
                opId: rec.id,
                attempt: attempts + 1,
                backoffMs: Math.max(0, nextAttemptAtMs - now),
                nextRetryAt: nextAttemptAtMs,
                capHit: false,
              });
              emitFlowTraceLog({
                event: "friendRequest:stateChange",
                opId: rec.id,
                from: rec.status,
                to: rec.status,
                why: "send-failed-retryable",
              });
              log.debug?.(`[delivery] retryable fail id=${rec.id} next=${nextAttemptAtMs}`);
            }
          }
        } catch (e) {
          emitFlowTraceLog({
            event: "requestSend:failed",
            opId: rec.id,
            errCode:
              e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
                ? ((e as { code?: string }).code ?? "UNKNOWN")
                : "UNKNOWN",
            errDetail: e instanceof Error ? e.message : String(e),
            attempt: attempts + 1,
          });
          log.warn?.(`[delivery] send threw id=${rec.id}`, e);
        } finally {
          inFlight.delete(rec.id);
        }
      }
    } catch (e) {
      log.error?.("[delivery] scheduler tick failed", e);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), tickMs);
      void tick();
      emitFlowTraceLog({
        event: "deliveryWorker:start",
        workerId,
        reason: "boot",
      });
      log.info?.(`[delivery] scheduler started tickMs=${tickMs}`);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      emitFlowTraceLog({
        event: "deliveryWorker:stop",
        workerId,
        reason: "shutdown",
      });
      log.info?.("[delivery] scheduler stopped");
    },
    _tick: tick,
  };
};
