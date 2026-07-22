export type TorWrapperState =
  | "not_started"
  | "starting"
  | "started"
  | "connecting"
  | "connected"
  | "stopping"
  | "stopped";

export type TorPluginState =
  | "starting_stopping"
  | "disabled"
  | "enabling"
  | "active"
  | "inactive";

export const TOR_DISABLED_REASON = {
  USER: 1,
  BATTERY: 2,
  MOBILE_DATA: 4,
} as const;

export type TorConnectionPolicy = {
  online: boolean;
  wifi: boolean;
  charging: boolean;
  enabledByUser: boolean;
  useMobileData: boolean;
  onlyWhenCharging: boolean;
};

export const evaluateTorConnectionPolicy = (policy: TorConnectionPolicy) => {
  if (!policy.online) {
    return {
      enableNetwork: false,
      enableConnectionPadding: false,
      reasonsDisabled: 0,
    };
  }

  let reasonsDisabled = 0;
  if (!policy.enabledByUser) reasonsDisabled |= TOR_DISABLED_REASON.USER;
  if (!policy.charging && policy.onlyWhenCharging) {
    reasonsDisabled |= TOR_DISABLED_REASON.BATTERY;
  }
  if (!policy.useMobileData && !policy.wifi) {
    reasonsDisabled |= TOR_DISABLED_REASON.MOBILE_DATA;
  }
  const enableNetwork = reasonsDisabled === 0;
  return {
    enableNetwork,
    enableConnectionPadding: enableNetwork && policy.wifi && policy.charging,
    reasonsDisabled,
  };
};

export class TorPollingBackoff {
  private count = 0;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly base: number;

  constructor(minIntervalMs: number, maxIntervalMs: number, base: number) {
    if (minIntervalMs <= 0 || maxIntervalMs < minIntervalMs || base <= 1) {
      throw new Error("invalid-tor-backoff-options");
    }
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.base = base;
  }

  getPollingInterval() {
    const interval = Math.trunc(this.minIntervalMs * Math.pow(this.base, this.count));
    return Math.min(interval, this.maxIntervalMs);
  }

  increment() {
    this.count += 1;
  }

  reset() {
    this.count = 0;
  }
}

export class TorPluginLifecycle {
  private wrapperState: TorWrapperState = "not_started";
  private settingsChecked = false;
  private reasonsDisabled = 0;

  setWrapperState(state: TorWrapperState) {
    this.wrapperState = state;
  }

  setReasonsDisabled(reasons: number) {
    this.settingsChecked = true;
    this.reasonsDisabled = reasons;
  }

  getState(): TorPluginState {
    if (
      !this.settingsChecked ||
      this.wrapperState === "not_started" ||
      this.wrapperState === "starting" ||
      this.wrapperState === "started" ||
      this.wrapperState === "stopping" ||
      this.wrapperState === "stopped"
    ) {
      return "starting_stopping";
    }
    if (this.reasonsDisabled !== 0) return "disabled";
    if (this.wrapperState === "connecting") return "enabling";
    if (this.wrapperState === "connected") return "active";
    return "inactive";
  }

  getReasonsDisabled() {
    return this.getState() === "disabled" ? this.reasonsDisabled : 0;
  }
}
