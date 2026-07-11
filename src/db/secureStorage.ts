import { decryptJsonRecord, deriveMkm, deriveVk, encryptJsonRecord, type VaultHeader } from "../crypto/vault";
import type { OutboxRecord } from "./schema";

export type SecureStoredPayload = {
  secure: {
    v: 1;
    recordType: string;
    encryptedFields: string[];
    enc_b64: string;
  };
};

export type SecureStoredRecord = Record<string, unknown> & SecureStoredPayload;

export type SecureTableLike<TStored extends SecureStoredRecord> = {
  put: (record: TStored) => Promise<unknown> | unknown;
  add?: (record: TStored) => Promise<unknown> | unknown;
  get: (id: string) => Promise<TStored | undefined> | TStored | undefined;
  toArray: () => Promise<TStored[]> | TStored[];
  bulkPut?: (records: TStored[]) => Promise<unknown> | unknown;
};

export type SecureStoreOptions<TPlain extends object> = {
  recordType: string;
  idField: Extract<keyof TPlain, string>;
  indexFields: Array<Extract<keyof TPlain, string>>;
  publicFields?: Array<Extract<keyof TPlain, string>>;
  sensitiveFields?: Array<Extract<keyof TPlain, string>>;
  encryptRemainder?: boolean;
  keyring?: SecureStorageKeyring;
};

export class SecureStorageKeyring {
  private key: Uint8Array | null = null;

  setMasterKey(key: Uint8Array, options: { wipeInput?: boolean } = {}) {
    this.clear();
    this.key = new Uint8Array(key);
    if (options.wipeInput) key.fill(0);
  }

  async unlockFromStartKey(startKey: string, header: VaultHeader) {
    const mkm = await deriveMkm(startKey, header);
    const vk = await deriveVk(mkm);
    try {
      this.setMasterKey(vk, { wipeInput: true });
    } finally {
      mkm.fill(0);
      vk.fill(0);
    }
  }

  withKey<T>(fn: (key: Uint8Array) => T): T {
    if (!this.key) throw new Error("secure_storage_locked");
    return fn(this.key);
  }

  isUnlocked() {
    return Boolean(this.key);
  }

  clear() {
    if (this.key) this.key.fill(0);
    this.key = null;
  }
}

export const defaultSecureStorageKeyring = new SecureStorageKeyring();

const textEncoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) => {
  const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const hashIndexValue = async (namespace: string, value: unknown) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("webcrypto_unavailable");
  }
  const bytes = textEncoder.encode(`${namespace}\0${JSON.stringify(value)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
};

const assertNoFieldOverlap = (left: string[], right: string[], label: string) => {
  const overlap = left.filter((field) => right.includes(field));
  if (overlap.length) {
    throw new Error(`${label}: ${overlap.join(",")}`);
  }
};

const requireRecordId = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid_secure_record_id");
  }
  return value;
};

export const createSecureStore = <TPlain extends object>(
  options: SecureStoreOptions<TPlain>
) => {
  const keyring = options.keyring ?? defaultSecureStorageKeyring;
  const indexFields = [...options.indexFields];
  const publicFields = Array.from(
    new Set([options.idField, ...indexFields, ...(options.publicFields ?? [])])
  );
  const sensitiveFields = options.sensitiveFields ?? [];
  const encryptRemainder = options.encryptRemainder ?? true;
  assertNoFieldOverlap(publicFields, sensitiveFields, "secure_storage_public_sensitive_overlap");

  const encryptRecord = async (record: TPlain): Promise<SecureStoredRecord> => {
    const id = requireRecordId(record[options.idField]);
    const clear: Record<string, unknown> = {};
    const encrypted: Record<string, unknown> = {};
    const publicSet = new Set<string>(publicFields);
    const sensitiveSet = new Set<string>(sensitiveFields);

    for (const field of publicFields) {
      clear[field] = record[field];
    }

    for (const [field, value] of Object.entries(record)) {
      if (publicSet.has(field)) continue;
      if (sensitiveSet.has(field) || encryptRemainder) {
        encrypted[field] = value;
      } else {
        clear[field] = value;
      }
    }

    const encryptedFields = Object.keys(encrypted).sort();
    const enc_b64 = await keyring.withKey((key) =>
      encryptJsonRecord(key, id, options.recordType, encrypted)
    );
    return {
      ...clear,
      secure: {
        v: 1,
        recordType: options.recordType,
        encryptedFields,
        enc_b64,
      },
    };
  };

  const decryptRecord = async (stored: SecureStoredRecord): Promise<TPlain> => {
    const id = requireRecordId(stored[options.idField]);
    if (
      stored.secure?.v !== 1 ||
      stored.secure.recordType !== options.recordType ||
      typeof stored.secure.enc_b64 !== "string"
    ) {
      throw new Error("invalid_secure_record");
    }
    const decrypted = await keyring.withKey((key) =>
      decryptJsonRecord<Record<string, unknown>>(
        key,
        id,
        options.recordType,
        stored.secure.enc_b64
      )
    );
    const { secure, ...clear } = stored;
    void secure;
    return { ...clear, ...decrypted } as TPlain;
  };

  return {
    encryptRecord,
    decryptRecord,
    put: async (table: SecureTableLike<SecureStoredRecord>, record: TPlain) =>
      table.put(await encryptRecord(record)),
    add: async (table: SecureTableLike<SecureStoredRecord>, record: TPlain) => {
      const encrypted = await encryptRecord(record);
      if (table.add) return table.add(encrypted);
      return table.put(encrypted);
    },
    bulkPut: async (table: SecureTableLike<SecureStoredRecord>, records: TPlain[]) => {
      const encrypted = await Promise.all(records.map((record) => encryptRecord(record)));
      if (table.bulkPut) return table.bulkPut(encrypted);
      await Promise.all(encrypted.map((record) => table.put(record)));
      return undefined;
    },
    get: async (table: SecureTableLike<SecureStoredRecord>, id: string) => {
      const stored = await table.get(id);
      return stored ? decryptRecord(stored) : undefined;
    },
    getAll: async (table: SecureTableLike<SecureStoredRecord>) => {
      const records = await table.toArray();
      return Promise.all(records.map((record) => decryptRecord(record)));
    },
  };
};

export const createSecureOutboxStore = (keyring = defaultSecureStorageKeyring) =>
  createSecureStore<OutboxRecord>({
    recordType: "outbox",
    idField: "id",
    indexFields: [
      "convId",
      "createdAtMs",
      "expiresAtMs",
      "status",
      "nextAttemptAtMs",
      "ackDeadlineMs",
    ],
    publicFields: [
      "createdAt",
      "ttlMs",
      "attempt",
      "nextAttemptAt",
      "attempts",
      "lastAttemptAtMs",
      "inFlightAtMs",
    ],
    sensitiveFields: ["ciphertext", "lastError", "toDeviceId", "torOnion", "alternateRoute"],
    keyring,
  });
