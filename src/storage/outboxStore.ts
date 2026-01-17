import { db, ensureDbOpen } from "../db/schema";
import type { OutboxRecord } from "../db/schema";

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

export const deleteExpiredOutbox = async (now = Date.now()) => {
  await ensureDbOpen();
  const expired = await db.outbox
    .where("expiresAtMs")
    .belowOrEqual(now)
    .and((record) => record.status === "pending")
    .toArray();
  if (!expired.length) return 0;
  await db.outbox.bulkDelete(expired.map((record) => record.id));
  return expired.length;
};
