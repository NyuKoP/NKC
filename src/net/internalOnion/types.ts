export type InternalOnionRouteStatus =
  | "building"
  | "ready"
  | "degraded"
  | "rebuilding"
  | "expired"
  | "idle";

export type InternalOnionHopStatus = "pending" | "ok" | "dead";

export type InternalOnionHopState = {
  hopIndex: number;
  peerId?: string;
  status: InternalOnionHopStatus;
  lastSeenTs?: number;
  rttMs?: number;
};

export type InternalOnionRouteState = {
  desiredHops: number;
  establishedHops: number;
  status: InternalOnionRouteStatus;
  circuitId?: string;
  hops: InternalOnionHopState[];
  lastError?: string;
  updatedAtTs: number;
};

export type HopHelloMessage = {
  type: "HOP_HELLO";
  circuitId: string;
  hopIndex: number;
  ts: number;
  senderPeerId: string;
  sig?: string;
};

export type HopAckMessage = {
  type: "HOP_ACK";
  circuitId: string;
  hopIndex: number;
  ts: number;
  relayPeerId: string;
  ok: boolean;
  sig?: string;
};

export type HopPingMessage = {
  type: "HOP_PING";
  circuitId: string;
  hopIndex: number;
  ts: number;
};

export type HopPongMessage = {
  type: "HOP_PONG";
  circuitId: string;
  hopIndex: number;
  ts: number;
};

export type InternalOnionControlPlaneMessage =
  | HopHelloMessage
  | HopAckMessage
  | HopPingMessage
  | HopPongMessage;

