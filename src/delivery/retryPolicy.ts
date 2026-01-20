export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type NetMode = "direct" | "tor" | "lokinet" | "onion";

export const retryByMode: Record<NetMode, RetryPolicy> = {
  direct: { maxAttempts: 6, baseDelayMs: 700, maxDelayMs: 10_000, jitterRatio: 0.15 },
  tor: { maxAttempts: 12, baseDelayMs: 2000, maxDelayMs: 90_000, jitterRatio: 0.25 },
  lokinet: { maxAttempts: 12, baseDelayMs: 2000, maxDelayMs: 90_000, jitterRatio: 0.25 },
  onion: { maxAttempts: 15, baseDelayMs: 3000, maxDelayMs: 120_000, jitterRatio: 0.3 },
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const computeBackoffMs = (attempts: number, policy: RetryPolicy) => {
  const exp = policy.baseDelayMs * Math.pow(2, Math.max(0, attempts));
  const capped = Math.min(exp, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio;
  const rand = (Math.random() * 2 - 1) * jitter;
  return Math.round(clamp(capped + rand, 0, policy.maxDelayMs));
};

export const computeNextAttemptAtMs = (now: number, attempts: number, policy: RetryPolicy) =>
  now + computeBackoffMs(attempts, policy);

export const canRetry = (attempts: number, policy: RetryPolicy) => attempts < policy.maxAttempts;
