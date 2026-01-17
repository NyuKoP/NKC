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
      version: "15.0.4",
      assetName: "tor-expert-bundle-windows-x86_64-15.0.4.tar.gz",
    });
    expect(hash).toBe(
      "cce12f8097b1657b56e22ec54cbed4b57fd5f8ff97cc426c21ebd5cc15173924"
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
