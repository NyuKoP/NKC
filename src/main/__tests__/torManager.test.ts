import { describe, expect, it } from "vitest";
import { parseTorBootstrapProgress } from "../torManager";

describe("TorManager bootstrap progress", () => {
  it("returns the highest bootstrap percentage from Tor output", () => {
    expect(
      parseTorBootstrapProgress(
        "Bootstrapped 5% (conn): Connecting\nBootstrapped 80% (ap_conn): Connecting\n"
      )
    ).toBe(80);
  });

  it("recognizes a completed Tor bootstrap", () => {
    expect(parseTorBootstrapProgress("Bootstrapped 100% (done): Done")).toBe(100);
  });

  it("ignores unrelated log messages and clamps invalid percentages", () => {
    expect(parseTorBootstrapProgress("Opening Socks listener")).toBe(0);
    expect(parseTorBootstrapProgress("Bootstrapped 999% (done): Done")).toBe(100);
  });
});
