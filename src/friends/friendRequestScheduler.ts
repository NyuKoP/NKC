import type { UserProfile } from "../db/repo";
import { createId } from "../utils/ids";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";

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
  let inFlight = false;
  const workerId = `friend-request-worker:${createId()}`;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const now = Date.now();
      const targets = getTargets().filter(
        (friend) =>
          friend.friendStatus === "request_out" &&
          friend.reachability?.status !== "expired"
      );
      const dueTargets = targets.filter((friend) => {
        const nextAttemptAt = friend.reachability?.nextAttemptAt ?? 0;
        if (nextAttemptAt && now < nextAttemptAt) return false;
        const lastAttemptAt = friend.reachability?.lastAttemptAt ?? 0;
        if (now - lastAttemptAt < 5_000) return false;
        return true;
      });
      emitFlowTraceLog({
        event: "deliveryWorker:tick",
        workerId,
        queued: targets.length,
        deferred: Math.max(0, targets.length - dueTargets.length),
        dueNow: dueTargets.length,
        inflight: inFlight ? 1 : 0,
        memQueueLen: targets.length,
      });
      for (const friend of dueTargets) {
        const attempts = friend.reachability?.attempts ?? 0;
        const beforeStatus = friend.reachability?.status ?? "unknown";
        const opId = `${friend.id}:${now}`;
        emitFlowTraceLog({
          event: "deliveryWorker:pickup",
          traceId: opId,
          opId,
          friendIdHash: friend.id,
          attempt: attempts + 1,
          retryAtPrev: friend.reachability?.nextAttemptAt ?? null,
        });

        const ok = await onAttempt(friend);
        const nextAttempts = attempts + 1;
        const next = ok ? 0 : now + nextBackoffMs(Math.max(0, nextAttempts - 1));
        if (!ok) {
          emitFlowTraceLog({
            event: "retry:scheduled",
            opId,
            friendIdHash: friend.id,
            attempt: nextAttempts,
            backoffMs: Math.max(0, next - now),
            nextRetryAt: next,
            capHit: nextAttempts >= BACKOFF_STEPS_MS.length,
          });
        }
        await onUpdate(friend.id, {
          reachability: {
            status: ok ? "ok" : friend.reachability?.status ?? "unreachable",
            attempts: ok ? 0 : nextAttempts,
            lastAttemptAt: now,
            nextAttemptAt: ok ? undefined : next,
          },
        });
        emitFlowTraceLog({
          event: "friendRequest:stateChange",
          opId,
          friendIdHash: friend.id,
          from: beforeStatus,
          to: ok ? "sent" : "deferred",
          why: ok ? "attempt-ok" : "attempt-failed",
        });
      }
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    emitFlowTraceLog({
      event: "deliveryWorker:start",
      workerId,
      reason: "boot",
    });
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    emitFlowTraceLog({
      event: "deliveryWorker:stop",
      workerId,
      reason: "shutdown",
    });
  };

  start();
  return { stop };
};
