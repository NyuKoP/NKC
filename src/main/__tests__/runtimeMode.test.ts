import { describe, expect, it } from "vitest";
import { shouldUseDevRuntime } from "../runtimeMode";

describe("shouldUseDevRuntime", () => {
  it("uses the development runtime only for an unpackaged app with a renderer URL", () => {
    expect(shouldUseDevRuntime({ isPackaged: false, rendererUrl: "http://localhost:5173" })).toBe(
      true
    );
    expect(shouldUseDevRuntime({ isPackaged: false })).toBe(false);
  });

  it("never lets a packaged app use a development renderer or user-data directory", () => {
    expect(shouldUseDevRuntime({ isPackaged: true, rendererUrl: "http://localhost:5173" })).toBe(
      false
    );
  });
});
