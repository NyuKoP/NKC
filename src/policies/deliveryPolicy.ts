import type { OutboxRecord, ReceiptRecord } from "../db/schema";
import { computeExpiresAt } from "./ttl";
import { deleteExpiredOutbox, getOutbox, putOutbox, updateOutbox } from "../storage/outboxStore";
import { putReceipt } from "../storage/receiptStore";

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
    const record = await getOutbox(messageId);
    if (record) {
      await updateOutbox(messageId, { status: "acked" });
      const receipt: ReceiptRecord = {
        id: `delivered:${messageId}`,
        convId: record.convId,
        msgId: messageId,
        kind: "delivered",
        ts: Date.now(),
      };
      await putReceipt(receipt);
    }
  } catch (error) {
    console.warn("[delivery] ack cleanup failed", error);
  }
};

export const sweepExpired = async (now = Date.now()) => deleteExpiredOutbox(now);
