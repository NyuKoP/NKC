import type { HttpClient } from "../../net/httpClient";
import type { NetConfig } from "../../net/netConfig";
import { detectLocalOnionProxy } from "../../net/onionProxyDetect";
import type { Transport, TransportPacket, TransportState } from "./types";

type Handler<T> = (payload: T) => void;

type OnionRouterOptions = {
  httpClient: HttpClient;
  config: NetConfig;
};

export const createOnionRouterTransport = ({
  httpClient,
  config,
}: OnionRouterOptions): Transport => {
  let state: TransportState = "idle";
  let activeProxyUrl: string | null = null;
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
      const detected = await detectLocalOnionProxy(config);
      if (!detected) {
        emitState("failed");
        throw new Error("Onion proxy not reachable");
      }
      activeProxyUrl = detected;
      emitState("connected");
    },
    async stop() {
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      if (!activeProxyUrl) {
        throw new Error("Onion proxy is not ready");
      }
      // TODO: send to local onion proxy API once defined.
      await httpClient.request(new URL("/onion/send", activeProxyUrl).toString(), {
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
