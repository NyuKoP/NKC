import { beforeEach, describe, expect, it, vi } from "vitest";

type OutboxRecord = {
  id: string;
  convId: string;
  ciphertext: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAttemptAtMs?: number;
  nextAttemptAtMs: number;
  attempts: number;
  status: "pending" | "in_flight" | "acked" | "expired";
  inFlightAtMs?: number;
  ackDeadlineMs?: number;
};

const store = new Map<string, OutboxRecord>();

vi.mock("../../storage/outboxStore", () => {
  return {
    putOutbox: async (record: OutboxRecord) => {
      store.set(record.id, record);
    },
    getOutbox: async (id: string) => store.get(id) ?? null,
    updateOutbox: vi.fn(async (id: string, patch: Partial<OutboxRecord>) => {
      const existing = store.get(id);
      if (!existing) return;
      store.set(id, { ...existing, ...patch });
    }),
    deleteExpiredOutbox: async (now = Date.now()) => {
      let count = 0;
      for (const record of Array.from(store.values())) {
        if (record.status === "pending" && record.expiresAtMs <= now) {
          store.delete(record.id);
          count += 1;
        }
      }
      return count;
    },
  };
});

vi.mock("../../storage/receiptStore", () => {
  return {
    putReceipt: vi.fn(async () => {}),
  };
});

import { enqueueOutgoing, onAckReceived, sweepExpired } from "../deliveryPolicy";
import * as outboxStore from "../../storage/outboxStore";
import * as receiptStore from "../../storage/receiptStore";

describe("deliveryPolicy", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("enqueues outgoing messages", async () => {
    await enqueueOutgoing({
      id: "m1",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 1,
      expiresAtMs: 2,
      nextAttemptAtMs: 1,
      attempts: 0,
      status: "pending",
    });
    expect(store.has("m1")).toBe(true);
  });

  it("marks outbox acked and writes delivered receipt", async () => {
    store.set("m1", {
      id: "m1",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 1,
      expiresAtMs: 2,
      nextAttemptAtMs: 1,
      attempts: 0,
      status: "pending",
    });
    await onAckReceived("m1");
    const updated = store.get("m1");
    expect(updated?.status).toBe("acked");
    expect(vi.mocked(outboxStore.updateOutbox)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(receiptStore.putReceipt)).toHaveBeenCalledTimes(1);
  });

  it("sweeps expired records", async () => {
    store.set("m1", {
      id: "m1",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 1,
      expiresAtMs: 2,
      nextAttemptAtMs: 1,
      attempts: 0,
      status: "pending",
    });
    store.set("m2", {
      id: "m2",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 3,
      expiresAtMs: 100,
      nextAttemptAtMs: 3,
      attempts: 0,
      status: "pending",
    });
    store.set("m3", {
      id: "m3",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 1,
      expiresAtMs: 0,
      nextAttemptAtMs: 1,
      attempts: 0,
      status: "acked",
    });
    store.set("m4", {
      id: "m4",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: 1,
      expiresAtMs: 10,
      nextAttemptAtMs: 1,
      attempts: 0,
      status: "pending",
    });
    const removed = await sweepExpired(10);
    expect(removed).toBe(2);
    expect(store.has("m1")).toBe(false);
    expect(store.has("m2")).toBe(true);
    expect(store.has("m3")).toBe(true);
    expect(store.has("m4")).toBe(false);
  });
});
