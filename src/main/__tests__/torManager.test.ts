import { describe, expect, it } from "vitest";
import { parseTorBootstrapProgress, TorManager } from "../torManager";

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

describe("TorManager diagnostics", () => {
  it("returns a safe initial state without paths or routing identifiers", () => {
    const manager = new TorManager({ appDataDir: "unused" });
    expect(manager.getDiagnostics()).toEqual({
      state: "unavailable",
      bootstrapProgress: 0,
      processRunning: false,
      bridgeMode: "direct",
      pluginState: "starting_stopping",
      reasonsDisabled: 0,
    });
  });

  it("reuses a preconfigured hidden service after Tor has started", () => {
    const manager = new TorManager({ appDataDir: "unused" });
    manager.configureHiddenService({ localPort: 19080, virtPort: 80 });
    (manager as unknown as { process: object | null }).process = {};

    expect(() =>
      manager.configureHiddenService({ localPort: 19080, virtPort: 80 })
    ).not.toThrow();
    expect(() =>
      manager.configureHiddenService({ localPort: 19081, virtPort: 80 })
    ).toThrow("tor-hidden-service-already-running");
  });
});
