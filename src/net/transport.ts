export type TransportKind = "onion" | "direct";

export type TransportState = "idle" | "connecting" | "connected" | "failed";

export type TransportStatus = {
  state: TransportState;
  detail?: string;
};

export type PeerHint = {
  onionAddr?: string;
  lokinetAddr?: string;
  directAddr?: string;
};

export interface Transport {
  kind: TransportKind;
  connect(peerHint?: PeerHint): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
  onMessage(cb: (bytes: Uint8Array) => void): () => void;
  close(): Promise<void>;
  getStatus(): TransportStatus;
}
