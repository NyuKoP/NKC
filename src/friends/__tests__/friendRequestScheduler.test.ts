import { describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../db/repo";
import { startFriendRequestScheduler } from "../friendRequestScheduler";

const makeFriend = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: "friend-1",
  displayName: "Friend",
  status: "",
  theme: "dark",
  kind: "friend",
  friendStatus: "request_out",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("friendRequestScheduler", () => {
  it("schedules the first failed retry within five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = Date.now();
    const friend = makeFriend({
      reachability: { status: "unreachable", attempts: 0, lastAttemptAt: now - 10_000 },
    });
    const onUpdate = vi.fn(async (_friendId: string, patch: Partial<UserProfile>) => {
      friend.reachability = {
        ...(friend.reachability ?? { status: "unreachable" }),
        ...(patch.reachability ?? {}),
      };
    });
    const scheduler = startFriendRequestScheduler({
      getTargets: () => [friend],
      onAttempt: async () => false,
      onUpdate,
      intervalMs: 20,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(friend.reachability?.nextAttemptAt).toBe(now + 5_000);

    scheduler.stop();
    vi.useRealTimers();
  });

  it("resets attempts to zero when retry succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const friend = makeFriend({
      reachability: {
        status: "unreachable",
        attempts: 3,
        lastAttemptAt: Date.now() - 10_000,
      },
    });

    const onAttempt = vi.fn(async () => true);
    const onUpdate = vi.fn(async (_friendId: string, patch: Partial<UserProfile>) => {
      friend.reachability = {
        ...(friend.reachability ?? { status: "unreachable" }),
        ...(patch.reachability ?? {}),
      };
    });

    const scheduler = startFriendRequestScheduler({
      getTargets: () => [friend],
      onAttempt,
      onUpdate,
      intervalMs: 20,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(friend.reachability?.status).toBe("ok");
    expect(friend.reachability?.attempts).toBe(0);
    expect(friend.reachability?.nextAttemptAt).toBeUndefined();

    scheduler.stop();
    vi.useRealTimers();
  });
});
