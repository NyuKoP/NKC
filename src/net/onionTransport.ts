import { createOnionRouterTransport } from "../adapters/transports/onionRouterTransport";
import type { TransportPacket, TransportState as AdapterState } from "../adapters/transports/types";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { createHttpClient } from "./httpClient";
import { useNetConfigStore } from "./netConfigStore";
import { createId } from "../utils/ids";
import type { PeerHint, Transport, TransportStatus } from "./transport";

const normalizePayload = (payload: TransportPacket["payload"]) => {
  if (payload instanceof Uint8Array) return payload;
  if (payload && typeof payload === "object" && "b64" in payload) {
    const b64 = (payload as { b64?: unknown }).b64;
    if (typeof b64 === "string") return decodeBase64Url(b64);
  }
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return null;
};

const mapState = (state: AdapterState): TransportStatus["state"] => {
  if (state === "connecting") return "connecting";
  if (state === "connected" || state === "degraded") return "connected";
  if (state === "failed") return "failed";
  return "idle";
};

export const createOnionTransport = (): Transport => {
  const httpClient = createHttpClient();
  const adapter = createOnionRouterTransport({
    httpClient,
    config: useNetConfigStore.getState().config,
  });

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
    kind: "onion",
    async connect(peerHint?: PeerHint) {
      void peerHint;
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
      const packet: TransportPacket = {
        id: createId(),
        payload: { b64: encodeBase64Url(bytes) },
      };
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
