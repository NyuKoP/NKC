import type { UserProfile } from "../db/repo";

type SchedulerDeps = {
  getTargets: () => UserProfile[];
  onAttempt: (friend: UserProfile) => Promise<boolean>;
  onUpdate: (friendId: string, patch: Partial<UserProfile>) => Promise<void>;
  intervalMs?: number;
};

const BACKOFF_STEPS_MS = [60_000, 300_000, 1_800_000, 21_600_000];

const nextBackoffMs = (attempts: number) =>
  BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];

export const startFriendRequestScheduler = ({
  getTargets,
  onAttempt,
  onUpdate,
  intervalMs = 30_000,
}: SchedulerDeps) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const targets = getTargets().filter(
      (friend) =>
        friend.friendStatus === "request_out" &&
        friend.reachability?.status !== "expired"
    );
    for (const friend of targets) {
      const attempts = friend.reachability?.attempts ?? 0;
      const nextAttemptAt = friend.reachability?.nextAttemptAt ?? 0;
      if (nextAttemptAt && now < nextAttemptAt) continue;
      const lastAttemptAt = friend.reachability?.lastAttemptAt ?? 0;
      if (now - lastAttemptAt < 5_000) continue;

      const ok = await onAttempt(friend);
      const nextAttempts = attempts + 1;
      const next = ok ? 0 : now + nextBackoffMs(nextAttempts);
      await onUpdate(friend.id, {
        reachability: {
          status: ok ? "ok" : friend.reachability?.status ?? "unreachable",
          attempts: ok ? 0 : nextAttempts,
          lastAttemptAt: now,
          nextAttemptAt: ok ? undefined : next,
        },
      });
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  start();
  return { stop };
};
