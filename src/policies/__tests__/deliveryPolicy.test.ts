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
    deleteOutbox: vi.fn(async (id: string) => {
      store.delete(id);
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

import { enqueueOutgoing, onAckReceived, sweepExpired } from "../deliveryPolicy";
import * as outboxStore from "../../storage/outboxStore";

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

  it("removes outbox on ack idempotently", async () => {
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
    await onAckReceived("m1");
    expect(store.has("m1")).toBe(false);
    expect(vi.mocked(outboxStore.deleteOutbox)).toHaveBeenCalledTimes(2);
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
