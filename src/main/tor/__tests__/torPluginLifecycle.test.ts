import { describe, expect, it } from "vitest";
import {
  evaluateTorConnectionPolicy,
  TOR_DISABLED_REASON,
  TorPluginLifecycle,
  TorPollingBackoff,
} from "../torPluginLifecycle";

describe("TorPollingBackoff", () => {
  it("increases the polling interval and caps it", () => {
    const backoff = new TorPollingBackoff(100, 250, 2);
    expect(backoff.getPollingInterval()).toBe(100);
    backoff.increment();
    expect(backoff.getPollingInterval()).toBe(200);
    backoff.increment();
    expect(backoff.getPollingInterval()).toBe(250);
    backoff.reset();
    expect(backoff.getPollingInterval()).toBe(100);
  });
});

describe("TorPluginLifecycle", () => {
  it("maps startup, connection, active, and stopped states", () => {
    const lifecycle = new TorPluginLifecycle();
    expect(lifecycle.getState()).toBe("starting_stopping");
    lifecycle.setReasonsDisabled(0);
    lifecycle.setWrapperState("connecting");
    expect(lifecycle.getState()).toBe("enabling");
    lifecycle.setWrapperState("connected");
    expect(lifecycle.getState()).toBe("active");
    lifecycle.setWrapperState("stopped");
    expect(lifecycle.getState()).toBe("starting_stopping");
  });

  it("reports disabled reasons only while disabled", () => {
    const lifecycle = new TorPluginLifecycle();
    lifecycle.setWrapperState("connecting");
    lifecycle.setReasonsDisabled(TOR_DISABLED_REASON.BATTERY);
    expect(lifecycle.getState()).toBe("disabled");
    expect(lifecycle.getReasonsDisabled()).toBe(TOR_DISABLED_REASON.BATTERY);
  });
});

describe("evaluateTorConnectionPolicy", () => {
  it("combines user, battery, and mobile-data restrictions", () => {
    const result = evaluateTorConnectionPolicy({
      online: true,
      wifi: false,
      charging: false,
      enabledByUser: false,
      useMobileData: false,
      onlyWhenCharging: true,
    });
    expect(result).toEqual({
      enableNetwork: false,
      enableConnectionPadding: false,
      reasonsDisabled:
        TOR_DISABLED_REASON.USER |
        TOR_DISABLED_REASON.BATTERY |
        TOR_DISABLED_REASON.MOBILE_DATA,
    });
  });

  it("enables padding only on Wi-Fi while charging", () => {
    expect(
      evaluateTorConnectionPolicy({
        online: true,
        wifi: true,
        charging: true,
        enabledByUser: true,
        useMobileData: true,
        onlyWhenCharging: false,
      })
    ).toEqual({ enableNetwork: true, enableConnectionPadding: true, reasonsDisabled: 0 });
  });
});
