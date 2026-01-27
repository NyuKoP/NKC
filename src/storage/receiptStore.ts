import { db, ensureDbOpen } from "../db/schema";
import type { ReceiptRecord } from "../db/schema";

export const putReceipt = async (receipt: ReceiptRecord) => {
  await ensureDbOpen();
  await db.receipts.put(receipt);
};

export const putReadCursor = async (payload: {
  convId: string;
  actorId: string;
  cursorTs: number;
  anchorMsgId?: string;
}) => {
  if (!payload.convId || !payload.actorId || !Number.isFinite(payload.cursorTs)) return;
  await ensureDbOpen();

  const id = `read_cursor:${payload.convId}:${payload.actorId}`;
  const existing = await db.receipts.get(id);
  const nextCursorTs = Math.max(existing?.cursorTs ?? 0, payload.cursorTs);

  const record: ReceiptRecord = {
    id,
    convId: payload.convId,
    msgId: payload.anchorMsgId ?? id,
    kind: "read_cursor",
    ts: Date.now(),
    actorId: payload.actorId,
    cursorTs: nextCursorTs,
    anchorMsgId: payload.anchorMsgId,
  };
  await db.receipts.put(record);

  if (payload.anchorMsgId) {
    await db.receipts.put({
      id: `read:${payload.anchorMsgId}:${payload.actorId}`,
      convId: payload.convId,
      msgId: payload.anchorMsgId,
      kind: "read",
      ts: nextCursorTs,
      actorId: payload.actorId,
    });
  }
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

export const getReadCursors = async (convId: string) => {
  await ensureDbOpen();
  const records = await db.receipts
    .where("[convId+kind]")
    .equals([convId, "read_cursor"])
    .toArray();
  const map: Record<string, number> = {};
  records.forEach((record) => {
    if (!record.actorId) return;
    const cursorTs = Number(record.cursorTs);
    if (!Number.isFinite(cursorTs)) return;
    const prev = map[record.actorId] ?? 0;
    if (cursorTs > prev) {
      map[record.actorId] = cursorTs;
    }
  });
  return map;
};
