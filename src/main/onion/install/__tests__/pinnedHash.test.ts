import { describe, expect, it } from "vitest";
import { getPinnedSha256 } from "../../componentRegistry";
import { PinnedHashMissingError } from "../../errors";
import { installTor } from "../installTor";

describe("pinned hash checks", () => {
  it.each([
    {
      platform: "darwin" as const,
      arch: "arm64" as const,
      assetName: "tor-expert-bundle-macos-aarch64-15.0.19.tar.gz",
      sha256: "c99cf6f69740a443c7fffaf598ceb0952b3914041507c8afe11bed84a3333eb1",
    },
    {
      platform: "win32" as const,
      arch: "x64" as const,
      assetName: "tor-expert-bundle-windows-x86_64-15.0.19.tar.gz",
      sha256: "6ac067402c7b4a3dc37887ed3754b3914b67fdc220c966190683e9ccf91abf0f",
    },
  ])("returns the pinned hash for $platform/$arch", ({ platform, arch, assetName, sha256 }) => {
    expect(getPinnedSha256("tor", { platform, arch, version: "15.0.19", assetName })).toBe(
      sha256
    );
  });

  it("blocks install when a pinned hash is missing", async () => {
    const tempDir = process.platform === "win32" ? "C:\\temp" : "/tmp";
    await expect(
      installTor(tempDir, "0.0.0", undefined, undefined, "missing.tar.gz")
    ).rejects.toBeInstanceOf(PinnedHashMissingError);
  });
});
