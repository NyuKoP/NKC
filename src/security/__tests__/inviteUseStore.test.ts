import { describe, expect, it } from "vitest";
import { isInviteUsed, markInviteUsed, runOneTimeInviteGuard } from "../inviteUseStore";

describe("inviteUseStore", () => {
  it("marks invite as used and blocks reuse", async () => {
    const fingerprint = "test-fp-1";
    expect(await isInviteUsed(fingerprint)).toBe(false);
    await markInviteUsed(fingerprint);
    expect(await isInviteUsed(fingerprint)).toBe(true);
  });

  it("guards one-time invite atomically across concurrent calls", async () => {
    const fingerprint = `race-fp-${Date.now()}`;
    const first = runOneTimeInviteGuard(
      fingerprint,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true as const };
      },
      (value) => value.ok
    );
    const second = runOneTimeInviteGuard(
      fingerprint,
      async () => ({ ok: true as const }),
      (value) => value.ok
    );
    const [a, b] = await Promise.all([first, second]);
    const successes = [a, b].filter((item) => item.ok).length;
    const failures = [a, b].filter((item) => !item.ok).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
    expect(await isInviteUsed(fingerprint)).toBe(true);
  });

  it("does not consume one-time invite when callback returns failure", async () => {
    const fingerprint = `retry-fp-${Date.now()}`;
    const failed = await runOneTimeInviteGuard(
      fingerprint,
      async () => ({ ok: false as const }),
      (value) => value.ok
    );
    expect(failed.ok).toBe(true);
    expect(await isInviteUsed(fingerprint)).toBe(false);
    const retried = await runOneTimeInviteGuard(
      fingerprint,
      async () => ({ ok: true as const }),
      (value) => value.ok
    );
    expect(retried.ok).toBe(true);
    expect(await isInviteUsed(fingerprint)).toBe(true);
  });
});
