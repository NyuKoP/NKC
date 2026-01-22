import { describe, expect, it } from "vitest";
import { isInviteUsed, markInviteUsed } from "../inviteUseStore";

describe("inviteUseStore", () => {
  it("marks invite as used and blocks reuse", async () => {
    const fingerprint = "test-fp-1";
    expect(await isInviteUsed(fingerprint)).toBe(false);
    await markInviteUsed(fingerprint);
    expect(await isInviteUsed(fingerprint)).toBe(true);
  });
});
