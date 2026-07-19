import { describe, expect, it } from "vitest";
import { getPinnedSha256 } from "../../componentRegistry";
import { PinnedHashMissingError } from "../../errors";
import { installalternateRoute } from "../installalternateRoute";
import { installTor } from "../installTor";

describe("pinned hash checks", () => {
  it("returns a pinned hash for a known Tor asset", () => {
    const hash = getPinnedSha256("tor", {
      platform: "win32",
      arch: "x64",
      version: "15.0.18",
      assetName: "tor-expert-bundle-windows-x86_64-15.0.18.tar.gz",
    });
    expect(hash).toBe(
      "6ac067402c7b4a3dc37887ed3754b3914b67fdc220c966190683e9ccf91abf0f"
    );
  });

  it("blocks install when a pinned hash is missing", async () => {
    const tempDir = process.platform === "win32" ? "C:\\temp" : "/tmp";
    await expect(
      installTor(tempDir, "0.0.0", undefined, undefined, "missing.tar.gz")
    ).rejects.toBeInstanceOf(PinnedHashMissingError);

    await expect(
      installalternateRoute(tempDir, "0.0.0", undefined, undefined, "missing.zip")
    ).rejects.toBeInstanceOf(PinnedHashMissingError);
  });
});
