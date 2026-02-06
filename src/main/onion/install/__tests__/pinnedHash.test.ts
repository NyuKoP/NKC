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
      version: "15.0.5",
      assetName: "tor-expert-bundle-windows-x86_64-15.0.5.tar.gz",
    });
    expect(hash).toBe(
      "49aabfe2958c8084e9fba1f78d85049e16a657e1f679b75102bbf9518497607f"
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
