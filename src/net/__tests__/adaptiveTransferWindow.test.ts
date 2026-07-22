import { describe, expect, it } from "vitest";
import { AdaptiveTransferWindow } from "../adaptiveTransferWindow";

describe("AdaptiveTransferWindow", () => {
  it("warms one lane before promoting to two", () => {
    const window = new AdaptiveTransferWindow(2, 3);
    expect(window.current).toBe(1);
    expect(window.onSuccess()).toBe(1);
    expect(window.onSuccess()).toBe(1);
    expect(window.onSuccess()).toBe(2);
  });

  it("falls back to one lane immediately after a failure", () => {
    const window = new AdaptiveTransferWindow(2, 1);
    expect(window.onSuccess()).toBe(2);
    expect(window.onFailure()).toBe(1);
  });

  it("never promotes beyond a one-lane cap", () => {
    const window = new AdaptiveTransferWindow(1, 1);
    expect(window.onSuccess()).toBe(1);
  });
});
