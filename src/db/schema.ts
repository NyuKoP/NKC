import Dexie from "dexie";
import type { Table } from "dexie";

export type MetaRecord = { key: string; value: string };
export type EncryptedRecord = { id: string; enc_b64: string; updatedAt: number };
export type MessageRecord = {
  id: string;
  convId: string;
  ts: number;
  enc_b64: string;
};
export type EventRecord = {
  eventId: string;
  convId: string;
  authorDeviceId: string;
  lamport: number;
  ts: number;
  envelopeJson: string;
  prevHash?: string;
  eventHash: string;
  conflict?: boolean;
};
export type OutboxRecord = {
  id: string;
  convId: string;
  ciphertext: string;
  toDeviceId?: string;
  torOnion?: string;
  lokinet?: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAttemptAtMs?: number;
  nextAttemptAtMs: number;
  attempts: number;
  status: "pending" | "in_flight" | "acked" | "expired";
  inFlightAtMs?: number;
  ackDeadlineMs?: number;
};
export type MediaChunkRecord = {
  id: string;
  ownerType: "profile" | "message";
  ownerId: string;
  idx: number;
  enc_b64: string;
  mime: string;
  total: number;
  updatedAt: number;
};
export type MediaIndexRecord = {
  mediaId: string;
  convId: string;
  filename: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  rootHash: string;
  createdAt: number;
  complete: boolean;
  corrupted?: boolean;
};
export type MediaPayloadChunkRecord = {
  mediaId: string;
  idx: number;
  nonce: string;
  ciphertext: string;
  chunkHash: string;
  updatedAt: number;
};
export type ReceiptRecord = {
  id: string;
  convId: string;
  msgId: string;
  kind: "delivered" | "read";
  ts: number;
};
export type TombstoneRecord = { id: string; type: string; deletedAt: number };

export class NKCVaultDB extends Dexie {
  meta!: Table<MetaRecord, string>;
  profiles!: Table<EncryptedRecord, string>;
  conversations!: Table<EncryptedRecord, string>;
  messages!: Table<MessageRecord, string>;
  events!: Table<EventRecord, string>;
  outbox!: Table<OutboxRecord, string>;
  mediaChunks!: Table<MediaChunkRecord, string>;
  mediaIndex!: Table<MediaIndexRecord, string>;
  mediaPayloadChunks!: Table<MediaPayloadChunkRecord, [string, number]>;
  receipts!: Table<ReceiptRecord, string>;
  tombstones!: Table<TombstoneRecord, string>;

  constructor() {
    super("nkc_vault");
    this.version(1).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      tombstones: "id, type, deletedAt",
    });
    this.version(2).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      outbox: "id, convId, createdAtMs, expiresAtMs, status",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      tombstones: "id, type, deletedAt",
    });
    this.version(3).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      outbox:
        "id, status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      tombstones: "id, type, deletedAt",
    });
    this.version(4).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      events: "eventId, convId, ts, lamport, authorDeviceId, [convId+lamport], [convId+ts]",
      outbox:
        "id, status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      tombstones: "id, type, deletedAt",
    });
    this.version(5).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      events: "eventId, convId, ts, lamport, authorDeviceId, [convId+lamport], [convId+ts]",
      outbox:
        "id, status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      mediaIndex: "mediaId, convId, createdAt, complete",
      mediaPayloadChunks: "[mediaId+idx], mediaId, idx, updatedAt",
      tombstones: "id, type, deletedAt",
    });
    this.version(6).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      events: "eventId, convId, ts, lamport, authorDeviceId, [convId+lamport], [convId+ts]",
      outbox:
        "id, status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      mediaIndex: "mediaId, convId, createdAt, complete",
      mediaPayloadChunks: "[mediaId+idx], mediaId, idx, updatedAt",
      receipts: "id, msgId, convId, kind, ts, [convId+msgId], [msgId+kind]",
      tombstones: "id, type, deletedAt",
    });
    this.version(7).stores({
      meta: "key",
      profiles: "id, updatedAt",
      conversations: "id, updatedAt",
      messages: "id, convId, ts",
      events: "eventId, convId, ts, lamport, authorDeviceId, [convId+lamport], [convId+ts]",
      outbox:
        "id, status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
      mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
      mediaIndex: "mediaId, convId, createdAt, complete",
      mediaPayloadChunks: "[mediaId+idx], mediaId, idx, updatedAt",
      receipts: "id, msgId, convId, kind, ts, [convId+msgId], [msgId+kind]",
      tombstones: "id, type, deletedAt",
    });
  }
}

export let db = new NKCVaultDB();

const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

const logDb = (message: string, detail?: Record<string, unknown>) => {
  if (!isDev) return;
  if (detail) {
    console.debug(`[db] ${message}`, detail);
  } else {
    console.debug(`[db] ${message}`);
  }
};

let resetPromise: Promise<void> | null = null;

export const ensureDbOpen = async () => {
  if (resetPromise) {
    await resetPromise;
  }
  if (!db.isOpen()) {
    logDb("open");
    await db.open();
    logDb("open:ready");
  }
  return db;
};

export const resetDb = async () => {
  if (resetPromise) return resetPromise;
  resetPromise = (async () => {
    logDb("delete:start");
    await db.delete();
    logDb("delete:done");
    db = new NKCVaultDB();
    logDb("open");
    await db.open();
    logDb("open:ready");
  })().finally(() => {
    resetPromise = null;
  });
  return resetPromise;
};
