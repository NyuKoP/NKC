import { sweepExpired } from "../policies/deliveryPolicy";
import type { OutboxRecord } from "../db/schema";
import type { NetMode, RetryPolicy } from "./retryPolicy";
import { retryByMode, canRetry, computeNextAttemptAtMs } from "./retryPolicy";
import { listRetryableOutbox, listInFlightTimedOut, updateOutbox } from "../storage/outboxStore";

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

  const policyForNow = (): RetryPolicy => retryByMode[getNetMode()];

  const tick = async () => {
    if (running) return;
    if (!isOnline()) return;

    running = true;
    const now = Date.now();
    const policy = policyForNow();

    try {
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
        log.debug?.(`[delivery] ack timeout -> pending id=${rec.id}`);
      }

      const items = await listRetryableOutbox(now, batchSize);
      for (const rec of items) {
        if (inFlight.has(rec.id)) continue;
        if (now >= rec.expiresAtMs) continue;

        const attempts = rec.attempts ?? 0;
        if (!canRetry(attempts, policy)) {
          log.warn?.(`[delivery] maxAttempts reached id=${rec.id} attempts=${attempts}`);
          continue;
        }

        inFlight.add(rec.id);

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
            log.debug?.(`[delivery] send ok -> in_flight id=${rec.id}`);
          } else {
            if (!result.retryable) {
              log.warn?.(`[delivery] non-retryable fail id=${rec.id}`);
            } else {
              log.debug?.(`[delivery] retryable fail id=${rec.id} next=${nextAttemptAtMs}`);
            }
          }
        } catch (e) {
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
      log.info?.(`[delivery] scheduler started tickMs=${tickMs}`);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      log.info?.("[delivery] scheduler stopped");
    },
    _tick: tick,
  };
};
