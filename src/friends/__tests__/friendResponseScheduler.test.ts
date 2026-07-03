import { describe, expect, it, vi } from "vitest";
import {
  startFriendResponseScheduler,
  type PendingFriendResponseTarget,
} from "../friendResponseScheduler";

const makeTarget = (
  overrides: Partial<PendingFriendResponseTarget> = {}
): PendingFriendResponseTarget => ({
  convId: "conv-1",
  friendId: "friend-1",
  response: "accept",
  ...overrides,
});

describe("friendResponseScheduler", () => {
  it("retries with backoff and stops after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const target = makeTarget();
    let shouldSucceed = false;
    let active = true;
    const onAttempt = vi.fn(async () => {
      if (!shouldSucceed) return false;
      active = false;
      return true;
    });

    const scheduler = startFriendResponseScheduler({
      getTargets: () => (active ? [target] : []),
      onAttempt,
      intervalMs: 20,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(onAttempt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAttempt).toHaveBeenCalledTimes(2);

    shouldSucceed = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onAttempt).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onAttempt).toHaveBeenCalledTimes(3);

    scheduler.stop();
    vi.useRealTimers();
  });
});
