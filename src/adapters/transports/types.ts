import type { ReceiveContext } from "../../accounts/receiveContext";
import type { IncomingCompletion } from "../../sync/receiveCompletion";

export type PacketHandler = (packet: TransportPacket, context?: ReceiveContext, binaryPacketBytes?: Uint8Array) =>
  IncomingCompletion | void | Promise<IncomingCompletion | void>;

export type TransportState = "idle" | "connecting" | "connected" | "degraded" | "failed";

export type TransportName = "directP2P" | "selfOnion" | "onionRouter";

export type { TransportPacket, PayloadB64 } from "./packetCodec";

import type { TransportPacket } from "./packetCodec";

export type TransportSendResult = {
  handoff: "peer" | "mailbox" | "offline-queue";
};

export interface Transport {
  name: TransportName;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(packet: TransportPacket): Promise<void | TransportSendResult>;
  onMessage(cb: PacketHandler, options?: { authority?: number }): void;
  onAck(cb: (messageId: string, rttMs: number) => void): void;
  onState(cb: (state: TransportState) => void): void;
}
