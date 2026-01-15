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
  }
}

export const db = new NKCVaultDB();
