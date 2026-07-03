export type PendingFriendResponseType = "accept" | "decline";

export type PendingFriendResponseTarget = {
  convId: string;
  friendId: string;
  response: PendingFriendResponseType;
};

type SchedulerDeps = {
  getTargets: () => PendingFriendResponseTarget[];
  onAttempt: (target: PendingFriendResponseTarget) => Promise<boolean>;
  intervalMs?: number;
};

type AttemptState = {
  attempts: number;
  nextAttemptAt: number;
  lastAttemptAt: number;
};

const BACKOFF_STEPS_MS = [30_000, 120_000, 600_000, 3_600_000];

const nextBackoffMs = (attempts: number) =>
  BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];

export const startFriendResponseScheduler = ({
  getTargets,
  onAttempt,
  intervalMs = 30_000,
}: SchedulerDeps) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const states = new Map<string, AttemptState>();

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const targets = getTargets();
    const active = new Set(targets.map((target) => target.convId));
    Array.from(states.keys()).forEach((convId) => {
      if (!active.has(convId)) {
        states.delete(convId);
      }
    });

    for (const target of targets) {
      const current = states.get(target.convId) ?? { attempts: 0, nextAttemptAt: 0, lastAttemptAt: 0 };
      if (current.nextAttemptAt && now < current.nextAttemptAt) continue;
      if (now - current.lastAttemptAt < 5_000) continue;

      const ok = await onAttempt(target);
      if (ok) {
        states.delete(target.convId);
        continue;
      }
      const nextAttempts = current.attempts + 1;
      states.set(target.convId, {
        attempts: nextAttempts,
        lastAttemptAt: now,
        nextAttemptAt: now + nextBackoffMs(Math.max(0, nextAttempts - 1)),
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
