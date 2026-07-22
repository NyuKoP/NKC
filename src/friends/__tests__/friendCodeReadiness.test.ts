import { describe, expect, it } from "vitest";
import { isTorFriendCodeReady } from "../friendCodeReadiness";

describe("isTorFriendCodeReady", () => {
  it("requires a reachable Tor runtime and an onion address", () => {
    expect(
      isTorFriendCodeReady({ torState: "running" }, { onionAddr: "example.onion" })
    ).toBe(true);
  });

  it.each([null, "idle", "starting", "error"])(
    "rejects an onion address while Tor is %s",
    (torState) => {
      expect(isTorFriendCodeReady({ torState }, { onionAddr: "example.onion" })).toBe(false);
    }
  );

  it("rejects stale or missing route data even while Tor is reachable", () => {
    expect(isTorFriendCodeReady({ torState: "running" }, {})).toBe(false);
    expect(isTorFriendCodeReady({ torState: "running" }, { onionAddr: "   " })).toBe(false);
  });
});
