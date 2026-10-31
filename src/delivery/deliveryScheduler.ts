import { reconcileAcknowledgedNativeRetries, sweepExpired } from "../policies/deliveryPolicy";
import { reconcileRevokedNativeDevices } from "../devices/deviceApprovals";
import type { OutboxRecord } from "../db/schema";

export type NetMode = "direct" | "tor" | "onion";

import {
  listRetryableOutbox,
  listInFlightTimedOut,
  listPendingOutbox,
  markOutboxInFlightUnlessAcked,
  updateOutbox,
} from "../storage/outboxStore";
import { createId } from "../utils/ids";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { createSafeConsole } from "../diagnostics/safeConsole";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import type { VaultAccess } from "../db/vaultAccess";
import { countSessionStage } from "../diagnostics/sessionInvestigation";

const console = createSafeConsole(globalThis.console);

export type SendResult =
  | { ok: true; handoff?: "peer" | "offline-queue" }
  | { ok: false; retryable: boolean };

export type OutboxSender = (record: OutboxRecord, access?: VaultAccess) => Promise<SendResult>;

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
  const getNetMode: () => NetMode = opts.getNetMode ?? (() => "direct");
  const isOnline = opts.isOnline ?? (() => true);
  const log = opts.logger ?? console;
  const planDelivery = opts.planDelivery;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let wakePending = false;
  const inFlight = new Map<string, Promise<void>>();
  const workerId = `delivery-worker:${createId()}`;
  let reconciledNative: string | undefined;

  const tick = async () => {
    if (running) return;

    const online = isOnline();

    running = true;
    const waking = wakePending;
    wakePending = false;
    const now = Date.now();

    try {
      const context = await captureLocalOperationContext();
      const access = context?.vault;

      const instance = access ? await window.nkc?.nativeQueueInstance?.(access.session) : undefined;
      const identity = instance && access ? `${access.accountId}:${access.session.token}:${instance}` : undefined;
      const replay = Boolean(identity && identity !== reconciledNative);
      const revoked = context ? await reconcileRevokedNativeDevices(context, replay) : true;
      const receipts = access ? await reconcileAcknowledgedNativeRetries(access, undefined, replay) : true;

      if (identity && revoked && receipts) reconciledNative = identity;

      if (!online) return;
      const pending = await listPendingOutbox(access);

      if (waking) {
        for (const record of pending) {
          if (record.expiresAtMs > now && record.nextAttemptAtMs > now) {
            await updateOutbox(record.id, { nextAttemptAtMs: now }, access);
          }
        }
      }

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
      await sweepExpired(now, access);

      const timedOut = await listInFlightTimedOut(now, batchSize, access);

      for (const rec of timedOut) {
        if (now >= rec.expiresAtMs) continue;
        await updateOutbox(rec.id, {
          status: "pending",
          ackDeadlineMs: undefined,
          inFlightAtMs: undefined,
          nextAttemptAtMs: now,
        }, access);
        emitFlowTraceLog({
          event: "friendRequest:stateChange",
          opId: rec.id,
          from: "in_flight",
          to: "queued",
          why: "ack-timeout",
        });
        log.debug?.(`[delivery] ack timeout -> pending id=${rec.id}`);
      }

      const candidates = await listRetryableOutbox(now, planDelivery ? batchSize * 4 : batchSize, access);

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

        if (inFlight.size >= batchSize) { countSessionStage("outbox-dispatch", "deferred"); continue; }

        if (now >= rec.expiresAtMs) continue;

        const attempts = rec.attempts ?? 0;
        const planned = plannedById.get(rec.id);

        if (!planned) continue;
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

        // Each send settles on its own: one slow Tor request must not hold later due rows
        // (transport concurrency stays bounded by the router's priority send queue).
        countSessionStage("outbox-dispatch", "input");
        inFlight.set(rec.id, (async () => { try {
          await updateOutbox(rec.id, {
            attempts: nextAttempts,
            lastAttemptAtMs: now,
            nextAttemptAtMs,
          }, access);
          countSessionStage("outbox-dispatch", "success");

          const result = await send({
            ...rec,
            attempts: nextAttempts,
            lastAttemptAtMs: now,
            nextAttemptAtMs,
          }, access);

          if (result.ok) {
            if (result.handoff === "offline-queue") {
              await updateOutbox(rec.id, {
                status: "in_flight",
                inFlightAtMs: now,
                ackDeadlineMs: undefined,
              }, access);
              emitFlowTraceLog({
                event: "friendRequest:stateChange",
                opId: rec.id,
                from: rec.status,
                to: "in_flight",
                why: "native-offline-queue",
              });
              log.debug?.(`[delivery] native offline queue owns retry id=${rec.id}`);

              return;
            }

            const movedToInFlight = await markOutboxInFlightUnlessAcked(rec.id, {
              inFlightAtMs: now,
              ackDeadlineMs: now + ackTimeoutMs,
            }, access);

            if (movedToInFlight) {
              emitFlowTraceLog({
                event: "friendRequest:stateChange",
                opId: rec.id,
                from: rec.status,
                to: "in_flight",
                why: "send-ok",
              });
              log.debug?.(`[delivery] send ok -> in_flight id=${rec.id}`);
            } else {
              log.debug?.(`[delivery] send ok; ack already recorded id=${rec.id}`);
            }
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
              e && typeof e === "object" && "code" in e && typeof e.code === "string"
                ? (e.code ?? "UNKNOWN")
                : "UNKNOWN",
            errDetail: e instanceof Error ? e.message : String(e),
            attempt: attempts + 1,
          });
          countSessionStage("outbox-dispatch", "error");
          log.warn?.(`[delivery] send threw id=${rec.id}`, e);
        } finally {
          inFlight.delete(rec.id);
        } })());
      }
    } catch (e) {
      log.error?.("[delivery] scheduler tick failed", e);
    } finally {
      running = false;

      if (wakePending && timer) void tick();
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
      wakePending = false;

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
    _tick: async () => { await tick(); await Promise.all(inFlight.values()); },
    wake() {
      if (!timer) return;
      wakePending = true;
      void tick();
    },
  };
};
