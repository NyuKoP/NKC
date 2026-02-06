import { describe, expect, it } from "vitest";
import { getBinaryPath } from "../componentRegistry";

describe("componentRegistry", () => {
  it("uses lowercase tor directory for tor expert bundle binaries", () => {
    const normalize = (value: string) => value.replaceAll("\\", "/");
    expect(normalize(getBinaryPath("tor", "darwin"))).toBe("tor/tor");
    expect(normalize(getBinaryPath("tor", "linux"))).toBe("tor/tor");
    expect(normalize(getBinaryPath("tor", "win32"))).toBe("tor/tor.exe");
  });
});
