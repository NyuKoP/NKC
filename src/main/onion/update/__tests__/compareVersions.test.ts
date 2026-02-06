import { describe, expect, it } from "vitest";
import { __testToLokinetCandidate, compareVersions } from "../checkUpdates";

describe("compareVersions", () => {
  it("compares dotted versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  it("treats missing parts as zeros", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });

  it("extracts a lokinet candidate with pinned hash when asset matches", () => {
    const candidate = __testToLokinetCandidate({
      tag_name: "v0.9.11",
      assets: [
        {
          name: "lokinet-0.9.11-win64.exe",
          browser_download_url:
            "https://github.com/oxen-io/lokinet/releases/download/v0.9.11/lokinet-0.9.11-win64.exe",
        },
      ],
    });

    expect(candidate).toMatchObject({
      version: "0.9.11",
      asset: {
        name: "lokinet-0.9.11-win64.exe",
      },
      sha256: "0a4a972e1f2d7d2af7f6aebcd15953d98f4ff53b5e823a7d7aa2953eeea2c8d2",
    });
  });

  it("returns null when release has no current-platform asset", () => {
    const candidate = __testToLokinetCandidate({
      tag_name: "v0.9.14",
      assets: [
        {
          name: "lokinet-linux-amd64-v0.9.14.tar.xz",
          browser_download_url:
            "https://github.com/oxen-io/lokinet/releases/download/v0.9.14/lokinet-linux-amd64-v0.9.14.tar.xz",
        },
      ],
    });

    if (process.platform === "win32") {
      expect(candidate).toBeNull();
    } else {
      expect(candidate).toMatchObject({
        version: "0.9.14",
        asset: { name: "lokinet-linux-amd64-v0.9.14.tar.xz" },
      });
    }
  });
});
