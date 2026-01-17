import type { NetConfig } from "./netConfig";
import { useNetConfigStore } from "./netConfigStore";
import { createRouteController, type RouteController } from "./routeController";
import { createHttpClient, type HttpClient } from "./httpClient";
import type { OutboxRecord } from "../db/schema";
import { computeExpiresAt } from "../policies/ttl";
import { enqueueOutgoing, onAckReceived } from "../policies/deliveryPolicy";
import { putOutbox } from "../storage/outboxStore";
import type { Transport, TransportPacket } from "../adapters/transports/types";
import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import { createSelfOnionTransport } from "../adapters/transports/selfOnionTransport";
import { createOnionRouterTransport } from "../adapters/transports/onionRouterTransport";

export type TransportKind = "directP2P" | "selfOnion" | "onionRouter";

type SendPayload = {
  convId: string;
  messageId: string;
  ciphertext: string;
  priority?: "high" | "normal";
};

type SendDeps = {
  config?: NetConfig;
  routeController?: RouteController;
  httpClient?: HttpClient;
  transports?: Partial<Record<TransportKind, Transport>>;
  resolveTransport?: (config: NetConfig, controller: RouteController) => TransportKind;
};

const defaultRouteController = createRouteController();
const defaultHttpClient = createHttpClient();
const transportCache = new Map<TransportKind, Transport>();
const transportStarted = new Set<TransportKind>();

const attachHandlers = (transport: Transport, controller: RouteController) => {
  transport.onAck((messageId, rttMs) => {
    controller.reportAck(messageId, rttMs);
    void onAckReceived(messageId);
  });
};

const getTransport = (
  kind: TransportKind,
  config: NetConfig,
  controller: RouteController,
  httpClient: HttpClient,
  overrides?: Partial<Record<TransportKind, Transport>>
) => {
  if (overrides?.[kind]) return overrides[kind] as Transport;
  if (transportCache.has(kind)) return transportCache.get(kind) as Transport;

  let transport: Transport;
  if (kind === "directP2P") {
    transport = createDirectP2PTransport();
  } else if (kind === "selfOnion") {
    transport = createSelfOnionTransport({ routeController: controller });
  } else {
    transport = createOnionRouterTransport({ httpClient, config });
  }
  attachHandlers(transport, controller);
  transportCache.set(kind, transport);
  return transport;
};

const ensureStarted = async (kind: TransportKind, transport: Transport) => {
  if (transportStarted.has(kind)) return;
  await transport.start();
  transportStarted.add(kind);
};

export const resolveTransport = (
  config: NetConfig,
  controller: RouteController = defaultRouteController
): TransportKind => {
  if (config.mode === "directP2P") return "directP2P";
  if (config.mode === "onionRouter") return "onionRouter";
  if (config.mode === "selfOnion") return "selfOnion";
  return controller.decideTransport(config);
};

const warnOnionRouterGuards = (config: NetConfig) => {
  if (config.mode !== "onionRouter") return;
  if (!config.disableLinkPreview || !config.webrtcRelayOnly) {
    console.warn("[net] Onion router guards should be enabled.");
  }
};

export const sendCiphertext = async (
  payload: SendPayload,
  deps: SendDeps = {}
) => {
  const config = deps.config ?? useNetConfigStore.getState().config;
  const controller = deps.routeController ?? defaultRouteController;
  const httpClient = deps.httpClient ?? defaultHttpClient;
  const createdAtMs = Date.now();
  const record: OutboxRecord = {
    id: payload.messageId,
    convId: payload.convId,
    ciphertext: payload.ciphertext,
    createdAtMs,
    expiresAtMs: computeExpiresAt(createdAtMs),
    lastAttemptAtMs: createdAtMs,
    attempts: 0,
    status: "pending",
  };

  warnOnionRouterGuards(config);
  await enqueueOutgoing(record);

  const attemptSend = async (kind: TransportKind) => {
    if (config.mode === "onionRouter" && kind === "directP2P") {
      throw new Error("Direct P2P blocked in onion router mode");
    }
    const transport = getTransport(kind, config, controller, httpClient, deps.transports);
    await ensureStarted(kind, transport);
    record.attempts += 1;
    record.lastAttemptAtMs = Date.now();
    await putOutbox(record);
    const packet: TransportPacket = { id: payload.messageId, payload: payload.ciphertext };
    await transport.send(packet);
    return kind;
  };

  const resolve = deps.resolveTransport ?? resolveTransport;
  const chosen = resolve(config, controller);
  try {
    const used = await attemptSend(chosen);
    return { ok: true, transport: used };
  } catch (error) {
    controller.reportSendFail(chosen);
    if (config.mode === "auto" && chosen === "selfOnion") {
      try {
        const used = await attemptSend("onionRouter");
        return { ok: true, transport: used };
      } catch (fallbackError) {
        controller.reportSendFail("onionRouter");
        return {
          ok: false,
          transport: "onionRouter",
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        };
      }
    }
    return {
      ok: false,
      transport: chosen,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
