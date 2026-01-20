import type { OutboxRecord } from "../db/schema";
import { computeExpiresAt } from "./ttl";
import { deleteExpiredOutbox, deleteOutbox, putOutbox } from "../storage/outboxStore";

export const enqueueOutgoing = async (record: OutboxRecord) => {
  const createdAtMs = record.createdAtMs ?? Date.now();
  const normalized: OutboxRecord = {
    ...record,
    createdAtMs,
    expiresAtMs: record.expiresAtMs ?? computeExpiresAt(createdAtMs),
    status: record.status ?? "pending",
    attempts: record.attempts ?? 0,
    nextAttemptAtMs: record.nextAttemptAtMs ?? createdAtMs,
  };
  await putOutbox(normalized);
};

export const onAckReceived = async (messageId: string) => {
  try {
    await deleteOutbox(messageId);
  } catch (error) {
    console.warn("[delivery] ack cleanup failed", error);
  }
};

export const sweepExpired = async (now = Date.now()) => deleteExpiredOutbox(now);
