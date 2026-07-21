import { describe, expect, it, vi } from "vitest";
import type { OnionStatus } from "../onionControl";
import { runVerifiedTorAutoUpdate, shouldAutoUpdateTor } from "../torAutoUpdate";

const status = (tor: OnionStatus["components"]["tor"]): OnionStatus => ({
  components: {
    tor,
  },
  runtime: { status: "idle" },
});

describe("Tor automatic updates", () => {
  it("updates only to a newer release that passed verification", () => {
    expect(
      shouldAutoUpdateTor({ installed: true, status: "ready", version: "15.0.17", latest: "15.0.18" })
    ).toBe(true);
    expect(
      shouldAutoUpdateTor({
        installed: true,
        status: "ready",
        version: "15.0.17",
        latest: "15.0.18",
        error: "PINNED_HASH_MISSING",
      })
    ).toBe(false);
  });

  it("checks and applies a verified Tor update", async () => {
    const applyUpdate = vi.fn().mockResolvedValue(undefined);

    await expect(
      runVerifiedTorAutoUpdate({
        checkUpdates: vi.fn().mockResolvedValue(
          status({ installed: true, status: "ready", version: "15.0.17", latest: "15.0.18" })
        ),
        applyUpdate,
      })
    ).resolves.toBe("updated");
    expect(applyUpdate).toHaveBeenCalledWith("tor");
  });
});
