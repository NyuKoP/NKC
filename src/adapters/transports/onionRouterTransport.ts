import type { HttpClient } from "../../net/httpClient";
import type { Transport, TransportPacket, TransportState } from "./types";

type Handler<T> = (payload: T) => void;

type OnionRouterOptions = {
  httpClient: HttpClient;
  proxyUrl: string;
};

export const createOnionRouterTransport = ({
  httpClient,
  proxyUrl,
}: OnionRouterOptions): Transport => {
  let state: TransportState = "idle";
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  return {
    name: "onionRouter",
    async start() {
      emitState("connecting");
      // TODO: validate proxy reachability.
      emitState("connected");
    },
    async stop() {
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      // TODO: send to local onion proxy API once defined.
      await httpClient.request(new URL("/onion/send", proxyUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
      });
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
