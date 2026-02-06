import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import type { TransportPacket, TransportState as AdapterState } from "../adapters/transports/types";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { createId } from "../utils/ids";
import type { PeerHint, Transport, TransportStatus } from "./transport";

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const normalizePayload = (payload: TransportPacket["payload"]) => {
  if (payload instanceof Uint8Array) return payload;
  if (payload && typeof payload === "object" && hasOwn(payload, "b64")) {
    const b64 = (payload as { b64?: unknown }).b64;
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

const DEFAULT_DIRECT_CONNECT_TIMEOUT_MS = 8_000;
const DEVICE_DIRECT_CONNECT_TIMEOUT_MS = 20_000;

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
    async connect(peerHint?: PeerHint) {
      status = { state: "connecting" };
      try {
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = (error?: unknown) => {
            if (done) return;
            done = true;
            if (timeout) {
              clearTimeout(timeout);
            }
            if (error) {
              reject(error);
              return;
            }
            resolve();
          };
          const timeoutMs =
            peerHint?.kind === "device"
              ? DEVICE_DIRECT_CONNECT_TIMEOUT_MS
              : DEFAULT_DIRECT_CONNECT_TIMEOUT_MS;
          const timeout = setTimeout(() => {
            finish(new Error("Direct P2P connect timeout"));
          }, timeoutMs);
          adapter.onState((next) => {
            if (next === "connected" || next === "degraded") {
              finish();
              return;
            }
            if (next === "failed") {
              finish(new Error("Direct P2P connect failed"));
            }
          });
          void adapter.start().catch((error) => {
            finish(error);
          });
        });
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
