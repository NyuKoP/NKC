import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import type { TransportPacket, TransportState as AdapterState } from "../adapters/transports/types";
import { createId } from "../utils/ids";
import type { PeerHint, Transport, TransportStatus } from "./transport";

const normalizePayload = (payload: TransportPacket["payload"]) => {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return null;
};

const mapState = (state: AdapterState): TransportStatus["state"] => {
  if (state === "connecting") return "connecting";
  if (state === "connected" || state === "degraded") return "connected";
  if (state === "failed") return "failed";
  return "idle";
};

export const createDirectTransport = (): Transport => {
  const adapter = createDirectP2PTransport();
  let status: TransportStatus = { state: "idle" };
  const messageHandlers = new Set<(bytes: Uint8Array) => void>();

  adapter.onMessage((packet) => {
    const bytes = normalizePayload(packet.payload);
    if (!bytes) return;
    messageHandlers.forEach((handler) => handler(bytes));
  });

  adapter.onState((state) => {
    status = { ...status, state: mapState(state) };
  });

  return {
    kind: "direct",
    async connect(_peerHint?: PeerHint) {
      status = { state: "connecting" };
      try {
        await adapter.start();
        status = { state: "connected" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        status = { state: "failed", detail };
        throw error;
      }
    },
    async send(bytes: Uint8Array) {
      const packet: TransportPacket = { id: createId(), payload: bytes };
      await adapter.send(packet);
    },
    onMessage(cb) {
      messageHandlers.add(cb);
      return () => {
        messageHandlers.delete(cb);
      };
    },
    async close() {
      await adapter.stop();
      status = { state: "idle" };
    },
    getStatus() {
      return status;
    },
  };
};
