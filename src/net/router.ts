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
import { updateConnectionStatus } from "./connectionStatus";
import { decideRouterTransport } from "./transportPolicy";

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
let transportStarted = new WeakSet<Transport>();

const attachHandlers = (
  transport: Transport,
  controller: RouteController,
  kind: TransportKind
) => {
  transport.onAck((messageId, rttMs) => {
    controller.reportAck(messageId, rttMs);
    void onAckReceived(messageId);
  });
  transport.onState((state) => {
    updateConnectionStatus(state, kind);
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
  attachHandlers(transport, controller, kind);
  transportCache.set(kind, transport);
  return transport;
};

const ensureStarted = async (transport: Transport) => {
  if (transportStarted.has(transport)) return;
  await transport.start();
  transportStarted.add(transport);
};

export const resolveTransport = (
  config: NetConfig,
  controller: RouteController = defaultRouteController
): TransportKind => decideRouterTransport(config, controller);

export const __testResetRouter = () => {
  transportCache.clear();
  transportStarted = new WeakSet<Transport>();
};

const warnOnionRouterGuards = (config: NetConfig) => {
  if (config.mode !== "onionRouter" && !config.onionEnabled) return;
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
    nextAttemptAtMs: createdAtMs,
    attempts: 0,
    status: "pending",
  };

  warnOnionRouterGuards(config);
  const resolve = deps.resolveTransport ?? resolveTransport;
  const chosen = resolve(config, controller);
  if (config.mode === "onionRouter" && chosen === "directP2P") {
    await putOutbox(record);
    controller.reportSendFail(chosen);
    return {
      ok: false,
      transport: chosen,
      error: "Direct P2P blocked in onion router mode",
    };
  }

  await enqueueOutgoing(record);

  const attemptSend = async (kind: TransportKind) => {
    if ((config.mode === "onionRouter" || config.onionEnabled) && kind === "directP2P") {
      throw new Error("Direct P2P blocked in onion router mode");
    }
    if (config.onionEnabled && kind === "selfOnion") {
      throw new Error("Self-onion blocked while onion router is enabled");
    }
    const transport = getTransport(kind, config, controller, httpClient, deps.transports);
    await ensureStarted(transport);
    record.attempts += 1;
    record.lastAttemptAtMs = Date.now();
    await putOutbox(record);
    const packet: TransportPacket = { id: payload.messageId, payload: payload.ciphertext };
    await transport.send(packet);
    return kind;
  };

  try {
    const used = await attemptSend(chosen);
    return { ok: true, transport: used };
  } catch (error) {
    controller.reportSendFail(chosen);
    if (config.mode === "selfOnion" && chosen === "selfOnion") {
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

export const sendOutboxRecord = async (
  record: OutboxRecord,
  deps: SendDeps = {}
) => {
  const config = deps.config ?? useNetConfigStore.getState().config;
  const controller = deps.routeController ?? defaultRouteController;
  const httpClient = deps.httpClient ?? defaultHttpClient;

  warnOnionRouterGuards(config);
  const resolve = deps.resolveTransport ?? resolveTransport;
  const chosen = resolve(config, controller);

  if (config.mode === "onionRouter" && chosen === "directP2P") {
    controller.reportSendFail(chosen);
    return { ok: false as const, retryable: false };
  }
  if (config.onionEnabled && chosen === "selfOnion") {
    controller.reportSendFail(chosen);
    return { ok: false as const, retryable: false };
  }

  const attemptSend = async (kind: TransportKind) => {
    if ((config.mode === "onionRouter" || config.onionEnabled) && kind === "directP2P") {
      throw new Error("Direct P2P blocked in onion router mode");
    }
    if (config.onionEnabled && kind === "selfOnion") {
      throw new Error("Self-onion blocked while onion router is enabled");
    }
    const transport = getTransport(kind, config, controller, httpClient, deps.transports);
    await ensureStarted(transport);
    const packet: TransportPacket = { id: record.id, payload: record.ciphertext };
    await transport.send(packet);
    return kind;
  };

  try {
    await attemptSend(chosen);
    return { ok: true as const };
  } catch {
    controller.reportSendFail(chosen);
    if (config.mode === "selfOnion" && chosen === "selfOnion") {
      try {
        await attemptSend("onionRouter");
        return { ok: true as const };
      } catch {
        controller.reportSendFail("onionRouter");
        return { ok: false as const, retryable: true };
      }
    }
    return { ok: false as const, retryable: true };
  }
};
