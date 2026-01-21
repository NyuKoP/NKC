import { db, ensureDbOpen } from "../db/schema";
import type { ReceiptRecord } from "../db/schema";

export const putReceipt = async (receipt: ReceiptRecord) => {
  await ensureDbOpen();
  await db.receipts.put(receipt);
};

export const getReceiptState = async (msgId: string) => {
  await ensureDbOpen();
  const records = await db.receipts.where("msgId").equals(msgId).toArray();
  return {
    delivered: records.some((record) => record.kind === "delivered"),
    read: records.some((record) => record.kind === "read"),
  };
};

export const listReceiptsByConv = async (convId: string) => {
  await ensureDbOpen();
  return db.receipts.where("convId").equals(convId).toArray();
};
