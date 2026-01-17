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
export type OutboxRecord = {
  id: string;
  convId: string;
  ciphertext: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAttemptAtMs?: number;
  attempts: number;
  status: "pending" | "acked" | "expired";
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
export type TombstoneRecord = { id: string; type: string; deletedAt: number };

export class NKCVaultDB extends Dexie {
  meta!: Table<MetaRecord, string>;
  profiles!: Table<EncryptedRecord, string>;
  conversations!: Table<EncryptedRecord, string>;
  messages!: Table<MessageRecord, string>;
  outbox!: Table<OutboxRecord, string>;
  mediaChunks!: Table<MediaChunkRecord, string>;
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
