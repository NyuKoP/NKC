import type { Transport, TransportPacket, TransportState } from "./types";
import type { RouteController } from "../../net/routeController";

type Handler<T> = (payload: T) => void;

type SelfOnionOptions = {
  routeController: RouteController;
  relayPool?: string[];
};

export const createSelfOnionTransport = ({
  routeController,
  relayPool = [],
}: SelfOnionOptions): Transport => {
  let state: TransportState = "idle";
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  const reportRelayPool = () => {
    routeController.reportRelayPoolSize(relayPool.length);
  };

  return {
    name: "selfOnion",
    async start() {
      emitState("connecting");
      reportRelayPool();
      if (relayPool.length === 0) {
        routeController.reportRouteBuildFail();
        emitState("failed");
        return;
      }
      // TODO: build relay chain with relayPool endpoints.
      emitState("connected");
    },
    async stop() {
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      // TODO: send through relay chain.
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
