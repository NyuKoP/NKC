import type { Transport, TransportPacket, TransportState } from "./types";
import { getDirectP2PRiskAck } from "../../security/preferences";

type Handler<T> = (payload: T) => void;

export const createDirectP2PTransport = (): Transport => {
  let state: TransportState = "idle";
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  return {
    name: "directP2P",
    async start() {
      const acked = await getDirectP2PRiskAck();
      if (!acked) {
        emitState("failed");
        throw new Error("Direct P2P risk not acknowledged");
      }
      emitState("connecting");
      // TODO: wire WebRTC signaling/peer setup.
      emitState("connected");
    },
    async stop() {
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      // TODO: send via WebRTC data channel.
      messageHandlers.forEach((handler) => handler(packet));
      ackHandlers.forEach((handler) => handler({ id: packet.id, rttMs: 0 }));
    },
    onMessage(cb) {
      messageHandlers.push(cb);
    },
    onAck(cb) {
      ackHandlers.push((payload) => cb(payload.id, payload.rttMs));
    },
    onState(cb) {
      stateHandlers.push(cb);
      cb(state);
    },
  };
};
