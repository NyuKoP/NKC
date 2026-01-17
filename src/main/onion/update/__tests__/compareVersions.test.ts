import { describe, expect, it } from "vitest";
import { compareVersions } from "../checkUpdates";

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
});
