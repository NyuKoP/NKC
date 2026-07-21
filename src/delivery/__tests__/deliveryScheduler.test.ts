import { beforeEach, describe, expect, it, vi } from "vitest";

const listRetryableOutbox = vi.fn();
const listPendingOutbox = vi.fn();
const listInFlightTimedOut = vi.fn();
const updateOutbox = vi.fn();
const markOutboxInFlightUnlessAcked = vi.fn();
const sweepExpired = vi.fn();

vi.mock("../../storage/outboxStore", () => {
  return {
    listPendingOutbox: (...args: unknown[]) => listPendingOutbox(...args),
    listRetryableOutbox: (...args: unknown[]) => listRetryableOutbox(...args),
    listInFlightTimedOut: (...args: unknown[]) => listInFlightTimedOut(...args),
    updateOutbox: (...args: unknown[]) => updateOutbox(...args),
    markOutboxInFlightUnlessAcked: (...args: unknown[]) =>
      markOutboxInFlightUnlessAcked(...args),
  };
});

vi.mock("../../policies/deliveryPolicy", () => {
  return {
    sweepExpired: (...args: unknown[]) => sweepExpired(...args),
  };
});

import { createDeliveryScheduler } from "../deliveryScheduler";
import type { OutboxRecord } from "../../db/schema";

const nativePlanner = async (payload: {
  now: number;
  items: Array<{ id: string; attempts: number }>;
}) => ({
  selected: payload.items.map((item) => ({
    id: item.id,
    attempts: item.attempts + 1,
    nextAttemptAtMs: payload.now + 2_000,
  })),
});

describe("deliveryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    listRetryableOutbox.mockReset();
    listPendingOutbox.mockReset();
    listInFlightTimedOut.mockReset();
    updateOutbox.mockReset();
    markOutboxInFlightUnlessAcked.mockReset();
    markOutboxInFlightUnlessAcked.mockResolvedValue(true);
    sweepExpired.mockReset();
  });

  it("demotes in-flight records after ack timeout", async () => {
    const now = Date.now();
    const record: OutboxRecord = {
      id: "m1",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: now - 5000,
      expiresAtMs: now + 5000,
      attempts: 1,
      nextAttemptAtMs: now - 1000,
      status: "in_flight",
      inFlightAtMs: now - 4000,
      ackDeadlineMs: now - 100,
    };
    listPendingOutbox.mockResolvedValue([]);
    listInFlightTimedOut.mockResolvedValue([record]);
    listRetryableOutbox.mockResolvedValue([]);
    const send = vi.fn(async () => ({ ok: true as const }));

    const scheduler = createDeliveryScheduler(send);
    await scheduler._tick();

    expect(updateOutbox).toHaveBeenCalledWith("m1", expect.objectContaining({
      status: "pending",
      nextAttemptAtMs: now,
    }));
  });

  it("sends pending records and marks in_flight on success", async () => {
    const now = Date.now();
    const record: OutboxRecord = {
      id: "m2",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: now - 2000,
      expiresAtMs: now + 10_000,
      attempts: 0,
      nextAttemptAtMs: now - 1,
      status: "pending",
    };
    listPendingOutbox.mockResolvedValue([record]);
    listInFlightTimedOut.mockResolvedValue([]);
    listRetryableOutbox.mockResolvedValue([record]);
    const send = vi.fn(async () => ({ ok: true as const }));

    const scheduler = createDeliveryScheduler(send, {
      ackTimeoutMs: 1000,
      planDelivery: nativePlanner,
    });
    await scheduler._tick();

    expect(updateOutbox).toHaveBeenCalledWith("m2", expect.objectContaining({
      attempts: 1,
      lastAttemptAtMs: now,
    }));
    expect(markOutboxInFlightUnlessAcked).toHaveBeenCalledWith("m2", expect.objectContaining({
      ackDeadlineMs: now + 1000,
    }));
  });

  it("does not overwrite an ack that arrives while send is completing", async () => {
    const now = Date.now();
    const record: OutboxRecord = {
      id: "m3",
      convId: "c1",
      ciphertext: "enc",
      createdAtMs: now - 100,
      expiresAtMs: now + 10_000,
      attempts: 0,
      nextAttemptAtMs: now,
      status: "pending",
    };
    listPendingOutbox.mockResolvedValue([record]);
    listInFlightTimedOut.mockResolvedValue([]);
    listRetryableOutbox.mockResolvedValue([record]);
    markOutboxInFlightUnlessAcked.mockResolvedValue(false);

    const scheduler = createDeliveryScheduler(vi.fn(async () => ({ ok: true as const })), {
      planDelivery: nativePlanner,
    });
    await scheduler._tick();

    expect(markOutboxInFlightUnlessAcked).toHaveBeenCalledOnce();
    expect(updateOutbox).not.toHaveBeenCalledWith(
      "m3",
      expect.objectContaining({ status: "in_flight" })
    );
  });
});
