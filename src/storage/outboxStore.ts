import { db, ensureDbOpen } from "../db/schema";
import type { OutboxRecord } from "../db/schema";

let normalizedDefaults = false;

export const ensureOutboxDefaults = async () => {
  if (normalizedDefaults) return;
  await ensureDbOpen();
  const records = await db.outbox
    .filter((record) => record.nextAttemptAtMs === undefined || record.nextAttemptAtMs === null)
    .toArray();
  if (records.length) {
    await Promise.all(
      records.map((record) =>
        db.outbox.update(record.id, {
          nextAttemptAtMs: record.createdAtMs ?? Date.now(),
          attempts: record.attempts ?? 0,
          status: record.status ?? "pending",
        })
      )
    );
  }
  normalizedDefaults = true;
};

export const putOutbox = async (record: OutboxRecord) => {
  await ensureDbOpen();
  await db.outbox.put(record);
};

export const getOutbox = async (id: string) => {
  await ensureDbOpen();
  return db.outbox.get(id);
};

export const deleteOutbox = async (id: string) => {
  await ensureDbOpen();
  await db.outbox.delete(id);
};

export const listPendingOutbox = async () => {
  await ensureDbOpen();
  return db.outbox.where("status").equals("pending").toArray();
};

export const listRetryableOutbox = async (now: number, limit: number) => {
  await ensureDbOpen();
  const items = await db.outbox
    .where("[status+nextAttemptAtMs]")
    .between(["pending", 0], ["pending", now], true, true)
    .filter((record) => record.expiresAtMs > now)
    .sortBy("nextAttemptAtMs");
  items.sort((a, b) => {
    if (a.nextAttemptAtMs !== b.nextAttemptAtMs) {
      return a.nextAttemptAtMs - b.nextAttemptAtMs;
    }
    return a.createdAtMs - b.createdAtMs;
  });
  return items.slice(0, limit);
};

export const listInFlightTimedOut = async (now: number, limit: number) => {
  await ensureDbOpen();
  const items = await db.outbox
    .where("[status+ackDeadlineMs]")
    .between(["in_flight", 0], ["in_flight", now], true, true)
    .filter((record) => record.expiresAtMs > now)
    .sortBy("ackDeadlineMs");
  return items.slice(0, limit);
};

export const updateOutbox = async (id: string, patch: Partial<OutboxRecord>) => {
  await ensureDbOpen();
  const n = await db.outbox.update(id, patch);
  void n;
};

export const deleteExpiredOutbox = async (now = Date.now()) => {
  await ensureDbOpen();
  const expired = await db.outbox
    .where("expiresAtMs")
    .belowOrEqual(now)
    .and((record) => record.status === "pending" || record.status === "in_flight")
    .toArray();
  if (!expired.length) return 0;
  await db.outbox.bulkDelete(expired.map((record) => record.id));
  return expired.length;
};

export const deleteFailedOutbox = async (minAttempts = 12) => {
  await ensureDbOpen();
  const failed = await db.outbox
    .where("status")
    .equals("pending")
    .filter((record) => (record.attempts ?? 0) >= minAttempts)
    .toArray();
  if (!failed.length) return 0;
  await db.outbox.bulkDelete(failed.map((record) => record.id));
  return failed.length;
};

export const listOutboxByConv = async (convId: string) => {
  await ensureDbOpen();
  const items = await db.outbox.toArray();
  return items.filter((record) => record.convId === convId);
};

export const clearOutboxQueue = async () => {
  await ensureDbOpen();
  await db.outbox.clear();
};
