import { sweepExpired } from "../policies/deliveryPolicy";
import type { OutboxRecord } from "../db/schema";
import type { NetMode, RetryPolicy } from "./retryPolicy";
import { retryByMode, canRetry, computeNextAttemptAtMs } from "./retryPolicy";
import {
  listRetryableOutbox,
  listInFlightTimedOut,
  listPendingOutbox,
  updateOutbox,
} from "../storage/outboxStore";
import { createId } from "../utils/ids";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";

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

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const inFlight = new Set<string>();
  const workerId = `delivery-worker:${createId()}`;

  const policyForNow = (): RetryPolicy => retryByMode[getNetMode()];

  const tick = async () => {
    if (running) return;
    if (!isOnline()) return;

    running = true;
    const now = Date.now();
    const policy = policyForNow();

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

      const items = await listRetryableOutbox(now, batchSize);
      for (const rec of items) {
        if (inFlight.has(rec.id)) continue;
        if (now >= rec.expiresAtMs) continue;

        const attempts = rec.attempts ?? 0;
        if (!canRetry(attempts, policy)) {
          emitFlowTraceLog({
            event: "retry:exhausted",
            opId: rec.id,
            attemptMax: attempts,
            finalErrCode: "MAX_ATTEMPTS_REACHED",
          });
          log.warn?.(`[delivery] maxAttempts reached id=${rec.id} attempts=${attempts}`);
          continue;
        }

        inFlight.add(rec.id);
        emitFlowTraceLog({
          event: "deliveryWorker:pickup",
          traceId: rec.id,
          opId: rec.id,
          friendIdHash: rec.convId,
          attempt: attempts + 1,
          retryAtPrev: rec.nextAttemptAtMs ?? null,
        });

        const nextAttemptAtMs = computeNextAttemptAtMs(now, attempts, policy);
        await updateOutbox(rec.id, {
          attempts: attempts + 1,
          lastAttemptAtMs: now,
          nextAttemptAtMs,
        });

        try {
          const result = await send({
            ...rec,
            attempts: attempts + 1,
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
                capHit: !canRetry(attempts + 1, policy),
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
