import { beforeEach, describe, expect, it, vi } from "vitest";

const listRetryableOutbox = vi.fn();
const listInFlightTimedOut = vi.fn();
const updateOutbox = vi.fn();
const sweepExpired = vi.fn();

vi.mock("../../storage/outboxStore", () => {
  return {
    listRetryableOutbox: (...args: unknown[]) => listRetryableOutbox(...args),
    listInFlightTimedOut: (...args: unknown[]) => listInFlightTimedOut(...args),
    updateOutbox: (...args: unknown[]) => updateOutbox(...args),
  };
});

vi.mock("../../policies/deliveryPolicy", () => {
  return {
    sweepExpired: (...args: unknown[]) => sweepExpired(...args),
  };
});

import { createDeliveryScheduler } from "../deliveryScheduler";
import type { OutboxRecord } from "../../db/schema";

describe("deliveryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    listRetryableOutbox.mockReset();
    listInFlightTimedOut.mockReset();
    updateOutbox.mockReset();
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
    listInFlightTimedOut.mockResolvedValue([]);
    listRetryableOutbox.mockResolvedValue([record]);
    const send = vi.fn(async () => ({ ok: true as const }));

    const scheduler = createDeliveryScheduler(send, { ackTimeoutMs: 1000 });
    await scheduler._tick();

    expect(updateOutbox).toHaveBeenCalledWith("m2", expect.objectContaining({
      attempts: 1,
      lastAttemptAtMs: now,
    }));
    expect(updateOutbox).toHaveBeenCalledWith("m2", expect.objectContaining({
      status: "in_flight",
      ackDeadlineMs: now + 1000,
    }));
  });
});
