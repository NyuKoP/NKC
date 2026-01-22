import { describe, expect, it, vi } from "vitest";
import { checkAllowed, recordFail, recordSuccess } from "../rateLimit";

describe("rateLimit", () => {
  it("backs off with exponential delay and resets on success", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const key = "k1";
    expect(checkAllowed(key).ok).toBe(true);

    recordFail(key);
    let blocked = checkAllowed(key);
    expect(blocked.ok).toBe(false);
    expect(blocked.waitMs).toBe(1000);

    vi.setSystemTime(new Date(1001));
    expect(checkAllowed(key).ok).toBe(true);

    recordFail(key);
    recordFail(key);
    blocked = checkAllowed(key);
    expect(blocked.waitMs).toBe(4000);

    recordSuccess(key);
    expect(checkAllowed(key).ok).toBe(true);

    vi.useRealTimers();
  });

  it("caps wait at 30 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const key = "k2";
    for (let i = 0; i < 10; i += 1) {
      recordFail(key);
    }
    const blocked = checkAllowed(key);
    expect(blocked.waitMs).toBe(30000);

    vi.useRealTimers();
  });
});
