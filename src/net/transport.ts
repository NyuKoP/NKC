import type { DeviceSyncTransportPolicy } from "../preferences";
import type { ReceiveContext } from "../accounts/receiveContext";
import type { IncomingCompletion } from "../sync/receiveCompletion";

export type MessageHandler = (bytes: Uint8Array, context?: ReceiveContext) =>
  IncomingCompletion | void | Promise<IncomingCompletion | void>;

export type TransportKind = "onion" | "direct";

export type TransportState = "idle" | "connecting" | "connected" | "failed";

export type TransportStatus = {
  state: TransportState;
  detail?: string;
};

export type PeerHint = {
  kind?: "friend" | "device";
  onionAddr?: string;
  peerDeviceId?: string;
  inboxWriteToken?: string;
  directAddr?: string;
  deviceSyncTransportPolicy?: DeviceSyncTransportPolicy;
  deviceAuthorizationVersion?: 2;
};

export interface Transport {
  kind: TransportKind;
  connect(peerHint?: PeerHint): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
  onMessage(cb: MessageHandler): () => void;
  close(): Promise<void>;
  getStatus(): TransportStatus;
}
