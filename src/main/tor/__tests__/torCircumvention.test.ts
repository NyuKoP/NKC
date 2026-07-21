import { describe, expect, it } from "vitest";
import {
  getSuitableBridgeTypes,
  normalizeCountryCode,
  resolveBridgeSelection,
  shouldUseBridges,
} from "../torCircumvention";

describe("torCircumvention", () => {
  it("normalizes country codes to ISO alpha-2 uppercase", () => {
    expect(normalizeCountryCode("kr")).toBe("KR");
    expect(normalizeCountryCode("US")).toBe("US");
    expect(normalizeCountryCode("")).toBe("ZZ");
    expect(normalizeCountryCode("abc")).toBe("ZZ");
  });

  it("returns bridge recommendation by country", () => {
    expect(shouldUseBridges("CN")).toBe(true);
    expect(shouldUseBridges("IR")).toBe(true);
    expect(shouldUseBridges("US")).toBe(false);
  });

  it("uses default bridge set when no country recommendation exists", () => {
    expect(getSuitableBridgeTypes("US")).toEqual(["DEFAULT_OBFS4", "VANILLA"]);
  });

  it("disables selection when mode is off or auto with non-recommended country", () => {
    const off = resolveBridgeSelection({ countryCode: "CN", mode: "off" });
    expect(off.enabled).toBe(false);
    expect(off.reason).toBe("mode-off");

    const autoNoRec = resolveBridgeSelection({ countryCode: "US", mode: "auto" });
    expect(autoNoRec.enabled).toBe(false);
    expect(autoNoRec.reason).toBe("country-not-recommended");
  });

  it("enables bridge lines when forced", () => {
    const forced = resolveBridgeSelection({ countryCode: "US", mode: "force" });
    expect(forced.enabled).toBe(true);
    expect(forced.lines.length).toBeGreaterThan(0);
  });
});

