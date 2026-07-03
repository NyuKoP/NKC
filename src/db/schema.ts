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
  createdAt?: number;
  ttlMs?: number;
  attempt?: number;
  nextAttemptAt?: number;
  lastError?: string;
  ciphertext: string;
  // Legacy metadata kept for compatibility with existing delivery modules.
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
  ownerType: "profile" | "message" | "group";
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
  kind: "delivered" | "read" | "read_cursor";
  ts: number;
  actorId?: string;
  cursorTs?: number;
  anchorMsgId?: string;
};
export type TombstoneRecord = { id: string; type: string; deletedAt: number };
export type FriendAliasRecord = {
  friendId: string;
  alias: string;
  updatedAt: number;
};

const OUTBOX_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  friendAliases!: Table<FriendAliasRecord, string>;

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
    this.version(8).stores({
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
      receipts:
        "id, msgId, convId, kind, actorId, cursorTs, ts, [convId+kind], [convId+actorId+kind], [convId+msgId], [msgId+kind]",
      tombstones: "id, type, deletedAt",
    });
    this.version(9).stores({
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
      receipts:
        "id, msgId, convId, kind, actorId, cursorTs, ts, [convId+kind], [convId+actorId+kind], [convId+msgId], [msgId+kind]",
      tombstones: "id, type, deletedAt",
    });
    this.version(10).stores({
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
      receipts:
        "id, msgId, convId, kind, actorId, cursorTs, ts, [convId+kind], [convId+actorId+kind], [convId+msgId], [msgId+kind]",
      tombstones: "id, type, deletedAt",
      friendAliases: "friendId, updatedAt",
    });
    this.version(11)
      .stores({
        meta: "key",
        profiles: "id, updatedAt",
        conversations: "id, updatedAt",
        messages: "id, convId, ts",
        events: "eventId, convId, ts, lamport, authorDeviceId, [convId+lamport], [convId+ts]",
        outbox:
          "id, convId, nextAttemptAt, [convId+nextAttemptAt], status, expiresAtMs, nextAttemptAtMs, ackDeadlineMs, [status+nextAttemptAtMs], [status+ackDeadlineMs]",
        mediaChunks: "id, ownerType, ownerId, idx, updatedAt",
        mediaIndex: "mediaId, convId, createdAt, complete",
        mediaPayloadChunks: "[mediaId+idx], mediaId, idx, updatedAt",
        receipts:
          "id, msgId, convId, kind, actorId, cursorTs, ts, [convId+kind], [convId+actorId+kind], [convId+msgId], [msgId+kind]",
        tombstones: "id, type, deletedAt",
        friendAliases: "friendId, updatedAt",
      })
      .upgrade((tx) =>
        tx
          .table("outbox")
          .toCollection()
          .modify((record: OutboxRecord) => {
            const createdAt = record.createdAt ?? record.createdAtMs ?? Date.now();
            const nextAttemptAt = record.nextAttemptAt ?? record.nextAttemptAtMs ?? createdAt;
            const attempt = record.attempt ?? record.attempts ?? 0;
            const ttlMs =
              record.ttlMs ??
              (typeof record.expiresAtMs === "number" && record.expiresAtMs > createdAt
                ? record.expiresAtMs - createdAt
                : OUTBOX_DEFAULT_TTL_MS);
            record.createdAt = createdAt;
            record.nextAttemptAt = nextAttemptAt;
            record.attempt = attempt;
            record.ttlMs = ttlMs;
            record.createdAtMs = record.createdAtMs ?? createdAt;
            record.nextAttemptAtMs = record.nextAttemptAtMs ?? nextAttemptAt;
            record.attempts = record.attempts ?? attempt;
            record.expiresAtMs = record.expiresAtMs ?? createdAt + ttlMs;
            record.status = record.status ?? "pending";
            if (typeof record.lastError !== "string") {
              record.lastError = "";
            }
          })
      );
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
