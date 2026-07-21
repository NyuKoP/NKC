import { describe, expect, it } from "vitest";
import {
  SecureStorageKeyring,
  createSecureOutboxStore,
  createSecureStore,
  hashIndexValue,
  type SecureStoredRecord,
  type SecureTableLike,
} from "../secureStorage";

type MessageRow = {
  id: string;
  convId: string;
  ts: number;
  payload: string;
  attachment?: { name: string; bytes: string };
};

class MemoryTable implements SecureTableLike<SecureStoredRecord> {
  private rows = new Map<string, SecureStoredRecord>();

  async put(record: SecureStoredRecord) {
    this.rows.set(String(record.id), record);
  }

  async add(record: SecureStoredRecord) {
    await this.put(record);
  }

  async get(id: string) {
    return this.rows.get(id);
  }

  async toArray() {
    return [...this.rows.values()];
  }

  raw(id: string) {
    return this.rows.get(id);
  }
}

const makeKeyring = () => {
  const keyring = new SecureStorageKeyring();
  keyring.setMasterKey(new Uint8Array(32).fill(7));
  return keyring;
};

describe("secureStorage", () => {
  it("encrypts sensitive fields while keeping index fields queryable", async () => {
    const table = new MemoryTable();
    const secureMessages = createSecureStore<MessageRow>({
      recordType: "message",
      idField: "id",
      indexFields: ["convId", "ts"],
      sensitiveFields: ["payload"],
      keyring: makeKeyring(),
    });

    await secureMessages.put(table, {
      id: "m1",
      convId: "c1",
      ts: 123,
      payload: "secret text",
      attachment: { name: "photo.png", bytes: "raw-bytes" },
    });

    const raw = table.raw("m1");
    expect(raw).toMatchObject({ id: "m1", convId: "c1", ts: 123 });
    expect(raw?.payload).toBeUndefined();
    expect(raw?.attachment).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("secret text");
    expect(JSON.stringify(raw)).not.toContain("raw-bytes");

    await expect(secureMessages.get(table, "m1")).resolves.toEqual({
      id: "m1",
      convId: "c1",
      ts: 123,
      payload: "secret text",
      attachment: { name: "photo.png", bytes: "raw-bytes" },
    });
  });

  it("decrypts all records from getAll", async () => {
    const table = new MemoryTable();
    const secureMessages = createSecureStore<MessageRow>({
      recordType: "message",
      idField: "id",
      indexFields: ["convId", "ts"],
      sensitiveFields: ["payload"],
      keyring: makeKeyring(),
    });

    await secureMessages.bulkPut(table, [
      { id: "m1", convId: "c1", ts: 1, payload: "one" },
      { id: "m2", convId: "c1", ts: 2, payload: "two" },
    ]);

    await expect(secureMessages.getAll(table)).resolves.toEqual([
      { id: "m1", convId: "c1", ts: 1, payload: "one" },
      { id: "m2", convId: "c1", ts: 2, payload: "two" },
    ]);
  });

  it("wipes input and in-memory key bytes on clear", () => {
    const keyring = new SecureStorageKeyring();
    const original = new Uint8Array(32).fill(9);
    keyring.setMasterKey(original, { wipeInput: true });
    expect([...original]).toEqual(new Array(32).fill(0));

    let captured: Uint8Array | null = null;
    keyring.withKey((key) => {
      captured = key;
    });
    keyring.clear();

    expect(keyring.isUnlocked()).toBe(false);
    expect(captured ? [...captured] : []).toEqual(new Array(32).fill(0));
  });

  it("rejects reads and writes when locked", async () => {
    const table = new MemoryTable();
    const keyring = new SecureStorageKeyring();
    const secureMessages = createSecureStore<MessageRow>({
      recordType: "message",
      idField: "id",
      indexFields: ["convId", "ts"],
      sensitiveFields: ["payload"],
      keyring,
    });

    await expect(
      secureMessages.put(table, { id: "m1", convId: "c1", ts: 1, payload: "secret" })
    ).rejects.toThrow("secure_storage_locked");
  });

  it("provides a secure outbox wrapper with retry metadata left in clear", async () => {
    const table = new MemoryTable();
    const outboxStore = createSecureOutboxStore(makeKeyring());
    await outboxStore.put(table, {
      id: "o1",
      convId: "c1",
      createdAtMs: 1,
      expiresAtMs: 100,
      nextAttemptAtMs: 5,
      attempts: 0,
      status: "pending",
      ciphertext: "encrypted-envelope-json",
    });

    const raw = table.raw("o1");
    expect(raw).toMatchObject({
      id: "o1",
      convId: "c1",
      status: "pending",
      nextAttemptAtMs: 5,
    });
    expect(raw?.ciphertext).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("encrypted-envelope-json");
    await expect(outboxStore.get(table, "o1")).resolves.toMatchObject({
      ciphertext: "encrypted-envelope-json",
      convId: "c1",
      status: "pending",
    });
  });

  it("hashes optional index values deterministically", async () => {
    const first = await hashIndexValue("conv", "c1");
    const second = await hashIndexValue("conv", "c1");
    const third = await hashIndexValue("conv", "c2");

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).not.toContain("c1");
  });
});
