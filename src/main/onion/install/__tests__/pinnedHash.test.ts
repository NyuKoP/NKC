import { describe, expect, it } from "vitest";
import { getPinnedSha256 } from "../../componentRegistry";
import { PinnedHashMissingError } from "../../errors";
import { installLokinet } from "../installLokinet";
import { installTor } from "../installTor";

describe("pinned hash checks", () => {
  it("returns a pinned hash for a known Tor asset", () => {
    const hash = getPinnedSha256("tor", {
      platform: "win32",
      arch: "x64",
      version: "15.0.17",
      assetName: "tor-expert-bundle-windows-x86_64-15.0.17.tar.gz",
    });
    expect(hash).toBe(
      "5f91e9426bf641dfe539dc28029088c72bed0b1d8f1c79104a0f89273cb3ebe1"
    );
  });

  it("blocks install when a pinned hash is missing", async () => {
    const tempDir = process.platform === "win32" ? "C:\\temp" : "/tmp";
    await expect(
      installTor(tempDir, "0.0.0", undefined, undefined, "missing.tar.gz")
    ).rejects.toBeInstanceOf(PinnedHashMissingError);

    await expect(
      installLokinet(tempDir, "0.0.0", undefined, undefined, "missing.zip")
    ).rejects.toBeInstanceOf(PinnedHashMissingError);
  });
});
