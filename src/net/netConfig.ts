import type { NetworkMode } from "./mode";

export interface NetConfig {
  mode: NetworkMode;
  onionProxyEnabled: boolean;
  onionProxyUrl: string;
  webrtcRelayOnly: boolean;
  disableLinkPreview: boolean;
  selfOnionEnabled: boolean;
  selfOnionMinRelays: number;
  allowRemoteProxy: boolean;
}

// Higher anonymity can increase latency; faster modes can expose IPs.
export const DEFAULT_NET_CONFIG: NetConfig = {
  mode: "auto",
  onionProxyEnabled: false,
  onionProxyUrl: "http://127.0.0.1:8080",
  webrtcRelayOnly: false,
  disableLinkPreview: false,
  selfOnionEnabled: true,
  selfOnionMinRelays: 5,
  allowRemoteProxy: false,
};
