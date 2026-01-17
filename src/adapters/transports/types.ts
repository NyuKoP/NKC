export type TransportState = "idle" | "connecting" | "connected" | "degraded" | "failed";

export type TransportName = "directP2P" | "selfOnion" | "onionRouter";

export type TransportPacket = {
  id: string;
  payload: unknown;
};

export interface Transport {
  name: TransportName;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(packet: TransportPacket): Promise<void>;
  onMessage(cb: (packet: TransportPacket) => void): void;
  onAck(cb: (messageId: string, rttMs: number) => void): void;
  onState(cb: (state: TransportState) => void): void;
}
