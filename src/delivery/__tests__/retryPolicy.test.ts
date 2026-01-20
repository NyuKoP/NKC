import { describe, expect, it } from "vitest";
import { computeNextAttemptAtMs, computeBackoffMs, type RetryPolicy } from "../retryPolicy";

describe("retryPolicy", () => {
  it("caps backoff and is monotonic with attempts", () => {
    const policy: RetryPolicy = {
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      jitterRatio: 0,
    };
    const now = 100;
    const d0 = computeBackoffMs(0, policy);
    const d1 = computeBackoffMs(1, policy);
    const d2 = computeBackoffMs(2, policy);
    const d3 = computeBackoffMs(3, policy);
    expect(d0).toBe(1000);
    expect(d1).toBe(2000);
    expect(d2).toBe(2000);
    expect(d3).toBe(2000);
    expect(computeNextAttemptAtMs(now, 0, policy)).toBe(now + d0);
    expect(computeNextAttemptAtMs(now, 1, policy)).toBe(now + d1);
  });
});
