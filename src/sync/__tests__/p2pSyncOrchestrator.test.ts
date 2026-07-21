import { describe, expect, it, vi } from "vitest";
import { createSecureOutboxStore, SecureStorageKeyring, type SecureStoredRecord } from "../../db/secureStorage";
import type { OutboxRecord } from "../../db/schema";
import type { ManagedConnection } from "../connectionManager";
import { P2PSyncOrchestrator, type P2POutboxTable, type P2PSyncEngineBridge } from "../p2pSyncOrchestrator";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class MemorySecureOutboxTable implements P2POutboxTable {
  rows = new Map<string, SecureStoredRecord>();

  async put(record: SecureStoredRecord) {
    this.rows.set(String(record.id), record);
  }

  async get(id: string) {
    return this.rows.get(id);
  }

  async toArray() {
    return [...this.rows.values()];
  }

  async delete(id: string) {
    this.rows.delete(id);
  }
}

class FakeConnection implements ManagedConnection {
  sent: string[] = [];
  closed = false;
  dataHandlers = new Set<(bytes: Uint8Array) => void>();
  closeHandlers = new Set<(error?: Error) => void>();

  send(bytes: Uint8Array) {
    this.sent.push(textDecoder.decode(bytes));
  }

  close() {
    this.closed = true;
  }

  onData(handler: (bytes: Uint8Array) => void) {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emitData(value: string) {
    const bytes = textEncoder.encode(value);
    this.dataHandlers.forEach((handler) => handler(bytes));
  }
}

const makeKeyring = () => {
  const keyring = new SecureStorageKeyring();
  keyring.setMasterKey(new Uint8Array(32).fill(3));
  return keyring;
};

const makeBridge = () => {
  let outbound: ((convId: string, bytes: Uint8Array) => Promise<void>) | null = null;
  const unbind = vi.fn(() => {
    outbound = null;
  });
  const bridge: P2PSyncEngineBridge & {
    sendOutbound: (convId: string, payload: string) => Promise<void>;
  } = {
    handleIncoming: vi.fn(),
    syncConversation: vi.fn(),
    bindOutbound: vi.fn((send) => {
      outbound = send;
      return unbind;
    }),
    reset: vi.fn(),
    sendOutbound: async (convId, payload) => {
      if (!outbound) throw new Error("outbound_not_bound");
      await outbound(convId, textEncoder.encode(payload));
    },
  };
  return { bridge, unbind };
};

const dueOutboxRecord = (patch: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id: "o1",
  convId: "c1",
  createdAtMs: 1,
  expiresAtMs: 10_000,
  nextAttemptAtMs: 1,
  attempts: 0,
  status: "pending",
  ciphertext: "queued-ciphertext",
  ...patch,
});

describe("P2PSyncOrchestrator", () => {
  it("activates after key injection and pipes inbound bytes into syncEngine", async () => {
    const keyring = makeKeyring();
    const table = new MemorySecureOutboxTable();
    const connection = new FakeConnection();
    const { bridge } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: table,
      syncEngine: bridge,
      now: () => 1,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);
    connection.emitData("incoming-sync-frame");

    expect(orchestrator.isActive()).toBe(true);
    expect(bridge.handleIncoming).toHaveBeenCalledWith(
      "c1",
      textEncoder.encode("incoming-sync-frame")
    );
  });

  it("binds syncEngine outbound frames to the conversation ConnectionManager", async () => {
    const keyring = makeKeyring();
    const connection = new FakeConnection();
    const { bridge } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: new MemorySecureOutboxTable(),
      syncEngine: bridge,
      now: () => 1,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);
    await bridge.sendOutbound("c1", "outbound-sync-frame");

    expect(connection.sent).toContain("outbound-sync-frame");
  });

  it("publishes conversation connection state changes", async () => {
    const keyring = makeKeyring();
    const connection = new FakeConnection();
    const onStateChange = vi.fn();
    const { bridge } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: new MemorySecureOutboxTable(),
      syncEngine: bridge,
      onStateChange,
      now: () => 1,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);

    expect(onStateChange).toHaveBeenCalledWith("c1", "connecting", undefined);
    expect(onStateChange).toHaveBeenCalledWith("c1", "connected", undefined);
  });


  it("flushes encrypted outbox records through the active connection and deletes delivered rows", async () => {
    const keyring = makeKeyring();
    const table = new MemorySecureOutboxTable();
    const secureOutbox = createSecureOutboxStore(keyring);
    await secureOutbox.put(table, dueOutboxRecord());

    const connection = new FakeConnection();
    const { bridge } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: table,
      syncEngine: bridge,
      now: () => 2,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);

    expect(connection.sent).toContain("queued-ciphertext");
    expect(await table.get("o1")).toBeUndefined();
  });

  it("ignores non-due or expired outbox records during flush", async () => {
    const keyring = makeKeyring();
    const table = new MemorySecureOutboxTable();
    const secureOutbox = createSecureOutboxStore(keyring);
    await secureOutbox.put(table, dueOutboxRecord({ id: "future", nextAttemptAtMs: 50 }));
    await secureOutbox.put(table, dueOutboxRecord({ id: "expired", expiresAtMs: 1 }));

    const connection = new FakeConnection();
    const { bridge } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: table,
      syncEngine: bridge,
      now: () => 10,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);

    expect(connection.sent).toEqual([]);
    expect(await table.get("future")).toBeTruthy();
    expect(await table.get("expired")).toBeTruthy();
  });

  it("stops managers, unbinds sync transport, resets sync engine, and wipes key on shutdown", async () => {
    const keyring = makeKeyring();
    const connection = new FakeConnection();
    const { bridge, unbind } = makeBridge();
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: new MemorySecureOutboxTable(),
      syncEngine: bridge,
      now: () => 1,
    });

    await orchestrator.activate([{ convId: "c1", connect: async () => connection }]);
    await orchestrator.shutdown();

    expect(connection.closed).toBe(true);
    expect(unbind).toHaveBeenCalled();
    expect(bridge.reset).toHaveBeenCalled();
    expect(keyring.isUnlocked()).toBe(false);
    await expect(bridge.sendOutbound("c1", "after-shutdown")).rejects.toThrow("outbound_not_bound");
  });

  it("zero-fills the in-memory key buffer during shutdown", async () => {
    const keyring = makeKeyring();
    let retainedKey: Uint8Array | null = null;
    keyring.withKey((key) => {
      retainedKey = key;
    });
    const orchestrator = new P2PSyncOrchestrator({
      keyring,
      outboxTable: new MemorySecureOutboxTable(),
      syncEngine: makeBridge().bridge,
      now: () => 1,
    });

    await orchestrator.activate();
    await orchestrator.shutdown();

    expect(Array.from(retainedKey ?? [])).toEqual(new Array(32).fill(0));
  });
});
