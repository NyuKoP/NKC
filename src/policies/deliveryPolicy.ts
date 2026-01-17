import type { OutboxRecord } from "../db/schema";
import { deleteExpiredOutbox, deleteOutbox, putOutbox } from "../storage/outboxStore";

export const enqueueOutgoing = async (record: OutboxRecord) => {
  await putOutbox(record);
};

export const onAckReceived = async (messageId: string) => {
  try {
    await deleteOutbox(messageId);
  } catch (error) {
    console.warn("[delivery] ack cleanup failed", error);
  }
};

export const sweepExpired = async (now = Date.now()) => deleteExpiredOutbox(now);
