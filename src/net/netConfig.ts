import type { NetworkMode } from "./mode";

export type OnionNetwork = "tor";

export type TorBridgeMode = "auto" | "off" | "force";

export type OnionComponentStatus = "idle" | "downloading" | "installing" | "ready" | "failed";

export type OnionComponentState = {
  installed: boolean;
  version?: string;
  latest?: string;
  status: OnionComponentStatus;
  error?: string;
  detail?: string;
  progress?: {
    receivedBytes: number;
    totalBytes: number;
  };
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
  torAutoPrepareOnAppStart?: boolean;
  torBridgeMode?: TorBridgeMode;
  tor: OnionComponentState;
  lastUpdateCheckAtMs?: number;
}

// Higher anonymity can increase latency; faster modes can expose IPs.
export const DEFAULT_NET_CONFIG: NetConfig = {
  mode: "onionRouter",
  onionProxyEnabled: true,
  onionProxyUrl: "http://127.0.0.1:8080",
  webrtcRelayOnly: true,
  disableLinkPreview: true,
  selfOnionEnabled: false,
  selfOnionMinRelays: 3,
  allowRemoteProxy: false,
  onionEnabled: true,
  onionSelectedNetwork: "tor",
  torAutoPrepareOnAppStart: true,
  torBridgeMode: "auto",
  tor: { installed: false, status: "idle" },
  lastUpdateCheckAtMs: undefined,
};

export const shouldAutoPrepareTor = (
  config: Pick<NetConfig, "mode" | "onionEnabled" | "torAutoPrepareOnAppStart">
) =>
  config.torAutoPrepareOnAppStart !== false &&
  (config.mode === "onionRouter" || config.onionEnabled);
