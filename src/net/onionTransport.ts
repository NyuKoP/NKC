import { createOnionRouterTransport } from "../adapters/transports/onionRouterTransport";
import type { TransportPacket, TransportState as AdapterState } from "../adapters/transports/types";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { createHttpClient } from "./httpClient";
import { useNetConfigStore } from "./netConfigStore";
import { createId } from "../utils/ids";
import { combineReceiveCompletions } from "../sync/receiveCompletion";
import type { PeerHint, Transport, TransportStatus, MessageHandler } from "./transport";

import { firstMessageMeasurement } from "../diagnostics/coldStartMetrics";

const normalizePayload = (payload: TransportPacket["payload"]) => {
  if (payload instanceof Uint8Array) return payload;

  if (payload && typeof payload === "object" && Object.hasOwn(payload, "b64")) {
    const b64 = payload.b64;

    if (typeof b64 === "string") {
      try {
        return decodeBase64Url(b64);
      } catch {
        return null;
      }
    }
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
    receiveAuthority: 10,
    httpClient,
    config: useNetConfigStore.getState().config,
  });

  let status: TransportStatus = { state: "idle" };
  let peer: PeerHint | undefined;
  const messageHandlers = new Set<MessageHandler>();

  adapter.onMessage(async (packet, context) => {
    const bytes = normalizePayload(packet.payload);

    if (!bytes) return;
    firstMessageMeasurement.bindPacketBytes(bytes, packet.id);

    return combineReceiveCompletions(await Promise.all(Array.from(messageHandlers, handler => handler(bytes, context))));
  });

  adapter.onState((state) => {
    status = { ...status, state: mapState(state) };
  });

  return {
    kind: "onion",
    async connect(peerHint?: PeerHint) {
      peer = peerHint;
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
      const packet: TransportPacket & {
        toDeviceId?: string;
        route: { torOnion?: string; inboxWriteToken?: string };
      } = {
        id: createId(),
        payload: { b64: encodeBase64Url(bytes) },
        toDeviceId: peer?.peerDeviceId,
        route: {
          torOnion: peer?.onionAddr,
          inboxWriteToken: peer?.inboxWriteToken,
        },
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
