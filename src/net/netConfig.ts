import type { NetworkMode } from "./mode";

export type OnionNetwork = "tor" | "lokinet";

export type OnionComponentStatus = "idle" | "downloading" | "installing" | "ready" | "failed";

export type OnionComponentState = {
  installed: boolean;
  version?: string;
  latest?: string;
  status: OnionComponentStatus;
  error?: string;
};

export interface NetConfig {
  mode: NetworkMode;
  onionProxyEnabled: boolean;
  onionProxyUrl: string;
  webrtcRelayOnly: boolean;
  disableLinkPreview: boolean;
  selfOnionEnabled: boolean;
  selfOnionMinRelays: number;
  allowRemoteProxy: boolean;
  onionEnabled: boolean;
  onionSelectedNetwork: OnionNetwork;
  tor: OnionComponentState;
  lokinet: OnionComponentState;
  lastUpdateCheckAtMs?: number;
}

// Higher anonymity can increase latency; faster modes can expose IPs.
export const DEFAULT_NET_CONFIG: NetConfig = {
  mode: "selfOnion",
  onionProxyEnabled: false,
  onionProxyUrl: "http://127.0.0.1:8080",
  webrtcRelayOnly: false,
  disableLinkPreview: false,
  selfOnionEnabled: true,
  selfOnionMinRelays: 5,
  allowRemoteProxy: false,
  onionEnabled: false,
  onionSelectedNetwork: "tor",
  tor: { installed: false, status: "idle" },
  lokinet: { installed: false, status: "idle" },
  lastUpdateCheckAtMs: undefined,
};
