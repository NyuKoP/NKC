import type { NetConfig } from "./netConfig";
import { useNetConfigStore } from "./netConfigStore";
import { createRouteController, type RouteController } from "./routeController";
import { createHttpClient, type HttpClient } from "./httpClient";
import type { OutboxRecord } from "../db/schema";
import { computeExpiresAt } from "../policies/ttl";
import { enqueueOutgoing, onAckReceived } from "../policies/deliveryPolicy";
import { putOutbox, updateOutbox } from "../storage/outboxStore";
import type { Transport, TransportPacket } from "../adapters/transports/types";
import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import { createSelfOnionTransport } from "../adapters/transports/selfOnionTransport";
import { createOnionRouterTransport } from "../adapters/transports/onionRouterTransport";
import { updateConnectionStatus } from "./connectionStatus";
import { decideRouterTransport } from "./transportPolicy";
import { useAppStore } from "../app/store";

export type TransportKind = "directP2P" | "selfOnion" | "onionRouter";
export type IncomingPacketMeta = {
  via: TransportKind;
};

type SendPayload = {
  convId: string;
  messageId: string;
  ciphertext: string;
  priority?: "high" | "normal";
  toDeviceId?: string;
  route?: {
    torOnion?: string;
    lokinet?: string;
  };
};

type SendDeps = {
  config?: NetConfig;
  routeController?: RouteController;
  httpClient?: HttpClient;
  transports?: Partial<Record<TransportKind, Transport>>;
  resolveTransport?: (config: NetConfig, controller: RouteController) => TransportKind;
};

type PrewarmDeps = SendDeps & {
  includeFallback?: boolean;
};

const defaultRouteController = createRouteController();
const defaultHttpClient = createHttpClient();
const transportCache = new Map<TransportKind, Transport>();
let transportStarted = new WeakSet<Transport>();
const inboundAttachedKinds = new Set<TransportKind>();

const debugLog = (label: string, payload: Record<string, unknown>) => {
  try {
    console.debug(label, JSON.stringify(payload));
  } catch {
    console.debug(label, payload);
  }
};

type DerivedRoutingMeta = {
  toDeviceId?: string;
  route?: { torOnion?: string; lokinet?: string };
  staleDeviceAliases?: string[];
};

const deriveRoutingMetaFromStores = (
  convId: string
): DerivedRoutingMeta => {
  const state = useAppStore.getState();
  const conv = state.convs.find((item) => item.id === convId);
  const me = state.userProfile;
  if (!conv || !me) return {};
  const isDirect =
    !(conv.type === "group" || conv.participants.length > 2) &&
    conv.participants.length === 2;
  if (!isDirect) return {};
  const partnerId = conv.participants.find((id) => id && id !== me.id) ?? null;
  if (!partnerId) return {};
  const partner = state.friends.find((friend) => friend.id === partnerId) ?? null;
  if (!partner) return {};
  const toDeviceId =
    partner.routingHints?.deviceId ??
    partner.primaryDeviceId ??
    partner.deviceId;
  const torOnion = partner.routingHints?.onionAddr;
  const lokinet = partner.routingHints?.lokinetAddr;
  return {
    toDeviceId,
    route: torOnion || lokinet ? { torOnion, lokinet } : undefined,
    staleDeviceAliases: [partner.friendId, partner.id].filter(
      (value): value is string => Boolean(value && value.trim())
    ),
  };
};

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
  if (!inboundAttachedKinds.has(kind)) {
    transport.onMessage((packet) => {
      inboundHandlers.forEach((handler) => handler(packet, { via: kind }));
    });
    inboundAttachedKinds.add(kind);
  }
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
  inboundAttachedKinds.clear();
};

const warnOnionRouterGuards = (config: NetConfig) => {
  if (config.mode !== "onionRouter" && !config.onionEnabled) return;
  if (!config.disableLinkPreview || !config.webrtcRelayOnly) {
    console.warn("[net] Onion router guards should be enabled.");
  }
};

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isRouteTargetMissingError = (message: string) =>
  message.includes("forward_failed:no_route_target") ||
  message.includes("forward_failed:no_route");

const isOnionProxyUnavailableError = (message: string) =>
  message.includes("forward_failed:no_proxy") ||
  message.includes("forward_failed:proxy_unreachable") ||
  message.includes("onion controller unavailable");

const isSelfOnionRouteNotReadyError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("internal onion route is not ready") ||
    normalized.includes("route_not_ready")
  );
};

const SELF_ONION_RETRY_DELAY_MS = 450;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const getPrewarmKinds = (
  chosen: TransportKind,
  includeFallback: boolean
): TransportKind[] => {
  if (!includeFallback) return [chosen];
  if (chosen === "onionRouter") return ["onionRouter", "directP2P", "selfOnion"];
  if (chosen === "directP2P") return ["directP2P", "onionRouter", "selfOnion"];
  return ["selfOnion", "onionRouter", "directP2P"];
};

const inboundHandlers = new Set<(packet: TransportPacket, meta: IncomingPacketMeta) => void>();
let inboundAttached = false;
let inboundStartPromise: Promise<void> | null = null;

export const prewarmRouter = async (deps: PrewarmDeps = {}) => {
  const config = deps.config ?? useNetConfigStore.getState().config;
  const controller = deps.routeController ?? defaultRouteController;
  const httpClient = deps.httpClient ?? defaultHttpClient;
  const resolve = deps.resolveTransport ?? resolveTransport;
  const chosen = resolve(config, controller);
  const requested = [...new Set(getPrewarmKinds(chosen, deps.includeFallback ?? true))];
  const settled = await Promise.all(
    requested.map(async (kind) => {
      try {
        const transport = getTransport(kind, config, controller, httpClient, deps.transports);
        await ensureStarted(transport);
        return { kind, ok: true as const };
      } catch (error) {
        controller.reportSendFail(kind);
        return { kind, ok: false as const, error: toErrorMessage(error) };
      }
    })
  );
  return {
    chosenTransport: chosen,
    requested,
    started: settled.filter((item) => item.ok).map((item) => item.kind),
    failed: settled
      .filter((item) => !item.ok)
      .map((item) => ({
        transport: item.kind,
        error: (item as { error?: string }).error ?? "unknown error",
      })),
    mode: config.mode,
    onionEnabled: config.onionEnabled,
    onionSelectedNetwork: config.onionSelectedNetwork,
  };
};

const ensureInboundListener = async () => {
  if (inboundStartPromise) return inboundStartPromise;
  const config = useNetConfigStore.getState().config;
  const controller = defaultRouteController;
  const httpClient = defaultHttpClient;
  const transports = [
    getTransport("onionRouter", config, controller, httpClient),
    getTransport("selfOnion", config, controller, httpClient),
  ];
  if (!inboundAttached) inboundAttached = true;
  inboundStartPromise = Promise.allSettled(
    transports.map((transport) => ensureStarted(transport))
  )
    .then((results) => {
      const allFailed = results.every((result) => result.status === "rejected");
      if (allFailed) {
        throw new Error("All inbound transports failed to start");
      }
    })
    .catch((error) => {
      inboundStartPromise = null;
      console.warn("[net] inbound listener failed to start", error);
    });
  return inboundStartPromise;
};

export const sendCiphertext = async (
  payload: SendPayload,
  deps: SendDeps = {}
) => {
  const config = deps.config ?? useNetConfigStore.getState().config;
  const controller = deps.routeController ?? defaultRouteController;
  const httpClient = deps.httpClient ?? defaultHttpClient;
  const derived = payload.toDeviceId
    ? {}
    : deriveRoutingMetaFromStores(payload.convId);
  const toDeviceId = payload.toDeviceId ?? derived.toDeviceId;
  const route = payload.route ?? derived.route;
  const createdAtMs = Date.now();
  const record: OutboxRecord = {
    id: payload.messageId,
    convId: payload.convId,
    ciphertext: payload.ciphertext,
    toDeviceId,
    torOnion: route?.torOnion,
    lokinet: route?.lokinet,
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
  const attemptTrace: Array<{
    transport: TransportKind;
    phase: "primary" | "fallback";
    ok: boolean;
    error?: string;
  }> = [];
  debugLog("[net] sendCiphertext: chosen transport", {
    convId: payload.convId,
    messageId: payload.messageId,
    chosen,
    mode: config.mode,
    onionEnabled: config.onionEnabled,
    onionSelectedNetwork: config.onionSelectedNetwork,
    hasToDeviceId: Boolean(toDeviceId),
    hasRoute: Boolean(route?.torOnion || route?.lokinet),
  });
  await enqueueOutgoing(record);

  const attemptSend = async (
    kind: TransportKind,
    options?: {
      allowDirectWhenOnionGuarded?: boolean;
      allowSelfOnionWhenOnionGuarded?: boolean;
    }
  ) => {
    if (
      (config.mode === "onionRouter" || config.onionEnabled) &&
      kind === "directP2P" &&
      !options?.allowDirectWhenOnionGuarded
    ) {
      throw new Error("Direct P2P blocked in onion router mode");
    }
    if (
      (config.mode === "onionRouter" || config.onionEnabled) &&
      kind === "selfOnion" &&
      !options?.allowSelfOnionWhenOnionGuarded
    ) {
      throw new Error("Self-onion blocked while onion router is enabled");
    }
    const transport = getTransport(kind, config, controller, httpClient, deps.transports);
    await ensureStarted(transport);
    record.attempts += 1;
    record.lastAttemptAtMs = Date.now();
    await putOutbox(record);
    const packet: TransportPacket = {
      id: payload.messageId,
      payload: payload.ciphertext,
      toDeviceId,
      route,
    } as TransportPacket;
    await transport.send(packet);
    return kind;
  };

  try {
    const used = await attemptSend(chosen);
    attemptTrace.push({ transport: chosen, phase: "primary", ok: true });
    debugLog("[net] sendCiphertext: send ok", {
      convId: payload.convId,
      messageId: payload.messageId,
      transport: used,
    });
    return {
      ok: true,
      transport: used,
      diagnostic: {
        chosenTransport: chosen,
        attempts: attemptTrace,
        hasToDeviceId: Boolean(toDeviceId),
        hasTorOnion: Boolean(route?.torOnion),
        hasLokinet: Boolean(route?.lokinet),
        mode: config.mode,
        onionEnabled: config.onionEnabled,
        onionSelectedNetwork: config.onionSelectedNetwork,
      },
    };
  } catch (error) {
    const primaryErrorMessage = toErrorMessage(error);
    attemptTrace.push({
      transport: chosen,
      phase: "primary",
      ok: false,
      error: primaryErrorMessage,
    });
    const attemptErrors: string[] = [
      `${chosen}: ${primaryErrorMessage}`,
    ];
    controller.reportSendFail(chosen);
    debugLog("[net] sendCiphertext: send failed", {
      convId: payload.convId,
      messageId: payload.messageId,
      chosen,
      error: primaryErrorMessage,
    });
    const allowDirectFallback =
      chosen === "onionRouter" &&
      (isRouteTargetMissingError(primaryErrorMessage) ||
        isOnionProxyUnavailableError(primaryErrorMessage));
    const allowSelfOnionFallback =
      chosen === "onionRouter" && isOnionProxyUnavailableError(primaryErrorMessage);
    const fallbackKinds: TransportKind[] =
      allowSelfOnionFallback
        ? ["selfOnion", "directP2P"]
        : allowDirectFallback
        ? ["directP2P"]
        : chosen === "directP2P"
        ? ["onionRouter", "selfOnion"]
        : config.mode === "selfOnion" && chosen === "selfOnion"
          ? ["onionRouter"]
          : [];
    for (const fallbackKind of fallbackKinds) {
      const maxAttempts = fallbackKind === "selfOnion" ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const used = await attemptSend(fallbackKind, {
            allowDirectWhenOnionGuarded: allowDirectFallback && fallbackKind === "directP2P",
            allowSelfOnionWhenOnionGuarded:
              allowSelfOnionFallback && fallbackKind === "selfOnion",
          });
          attemptTrace.push({ transport: fallbackKind, phase: "fallback", ok: true });
          debugLog("[net] sendCiphertext: fallback ok", {
            convId: payload.convId,
            messageId: payload.messageId,
            transport: used,
          });
          return {
            ok: true,
            transport: used,
            diagnostic: {
              chosenTransport: chosen,
              attempts: attemptTrace,
              allowDirectFallback,
              allowSelfOnionFallback,
              fallbackKinds,
              hasToDeviceId: Boolean(toDeviceId),
              hasTorOnion: Boolean(route?.torOnion),
              hasLokinet: Boolean(route?.lokinet),
              mode: config.mode,
              onionEnabled: config.onionEnabled,
              onionSelectedNetwork: config.onionSelectedNetwork,
            },
          };
        } catch (fallbackError) {
          const fallbackErrorMessage = toErrorMessage(fallbackError);
          attemptTrace.push({
            transport: fallbackKind,
            phase: "fallback",
            ok: false,
            error: fallbackErrorMessage,
          });
          const shouldRetrySelfOnion =
            fallbackKind === "selfOnion" &&
            attempt < maxAttempts &&
            isSelfOnionRouteNotReadyError(fallbackErrorMessage);
          if (shouldRetrySelfOnion) {
            debugLog("[net] sendCiphertext: fallback retry", {
              convId: payload.convId,
              messageId: payload.messageId,
              fallbackKind,
              attempt,
              maxAttempts,
              error: fallbackErrorMessage,
            });
            await wait(SELF_ONION_RETRY_DELAY_MS);
            continue;
          }
          attemptErrors.push(
            `${fallbackKind}: ${fallbackErrorMessage}`
          );
          controller.reportSendFail(fallbackKind);
          debugLog("[net] sendCiphertext: fallback failed", {
            convId: payload.convId,
            messageId: payload.messageId,
            fallbackKind,
            error: fallbackErrorMessage,
          });
          break;
        }
      }
    }
    return {
      ok: false,
      transport: chosen,
      error: attemptErrors.join(" || "),
      diagnostic: {
        chosenTransport: chosen,
        attempts: attemptTrace,
        allowDirectFallback,
        allowSelfOnionFallback,
        fallbackKinds,
        hasToDeviceId: Boolean(toDeviceId),
        hasTorOnion: Boolean(route?.torOnion),
        hasLokinet: Boolean(route?.lokinet),
        mode: config.mode,
        onionEnabled: config.onionEnabled,
        onionSelectedNetwork: config.onionSelectedNetwork,
      },
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
  const derived = deriveRoutingMetaFromStores(record.convId);
  const recordToDeviceId = record.toDeviceId?.trim();
  const hasStaleAlias = recordToDeviceId
    ? Boolean(derived.staleDeviceAliases?.includes(recordToDeviceId))
    : false;
  const toDeviceId = hasStaleAlias ? derived.toDeviceId : record.toDeviceId ?? derived.toDeviceId;
  const torOnion = record.torOnion ?? derived.route?.torOnion;
  const lokinet = record.lokinet ?? derived.route?.lokinet;

  if ((!record.toDeviceId || hasStaleAlias) && (toDeviceId || torOnion || lokinet)) {
    const patch: Partial<OutboxRecord> = {};
    if (toDeviceId) patch.toDeviceId = toDeviceId;
    if (torOnion) patch.torOnion = torOnion;
    if (lokinet) patch.lokinet = lokinet;
    if (Object.keys(patch).length) {
      await updateOutbox(record.id, patch);
    }
  }

  warnOnionRouterGuards(config);
  const resolve = deps.resolveTransport ?? resolveTransport;
  const chosen = resolve(config, controller);
  debugLog("[net] sendOutboxRecord: chosen transport", {
    convId: record.convId,
    messageId: record.id,
    chosen,
    mode: config.mode,
    onionEnabled: config.onionEnabled,
    onionSelectedNetwork: config.onionSelectedNetwork,
    hasToDeviceId: Boolean(toDeviceId),
    hasRoute: Boolean(torOnion || lokinet),
  });

  if (config.onionEnabled && chosen === "selfOnion") {
    controller.reportSendFail(chosen);
    return { ok: false as const, retryable: false };
  }

  const attemptSend = async (
    kind: TransportKind,
    options?: {
      allowDirectWhenOnionGuarded?: boolean;
      allowSelfOnionWhenOnionGuarded?: boolean;
    }
  ) => {
    if (
      (config.mode === "onionRouter" || config.onionEnabled) &&
      kind === "directP2P" &&
      !options?.allowDirectWhenOnionGuarded
    ) {
      throw new Error("Direct P2P blocked in onion router mode");
    }
    if (
      (config.mode === "onionRouter" || config.onionEnabled) &&
      kind === "selfOnion" &&
      !options?.allowSelfOnionWhenOnionGuarded
    ) {
      throw new Error("Self-onion blocked while onion router is enabled");
    }
    const transport = getTransport(kind, config, controller, httpClient, deps.transports);
    await ensureStarted(transport);
    const packet: TransportPacket = {
      id: record.id,
      payload: record.ciphertext,
      toDeviceId,
      route:
        torOnion || lokinet ? { torOnion, lokinet } : undefined,
    } as TransportPacket;
    await transport.send(packet);
    return kind;
  };

  try {
    await attemptSend(chosen);
    debugLog("[net] sendOutboxRecord: send ok", {
      convId: record.convId,
      messageId: record.id,
      transport: chosen,
    });
    return { ok: true as const };
  } catch (error) {
    const primaryErrorMessage = toErrorMessage(error);
    controller.reportSendFail(chosen);
    debugLog("[net] sendOutboxRecord: send failed", {
      convId: record.convId,
      messageId: record.id,
      chosen,
      error: primaryErrorMessage,
    });
    const allowDirectFallback =
      chosen === "onionRouter" &&
      (isRouteTargetMissingError(primaryErrorMessage) ||
        isOnionProxyUnavailableError(primaryErrorMessage));
    const allowSelfOnionFallback =
      chosen === "onionRouter" && isOnionProxyUnavailableError(primaryErrorMessage);
    const fallbackKinds: TransportKind[] =
      allowSelfOnionFallback
        ? ["selfOnion", "directP2P"]
        : allowDirectFallback
        ? ["directP2P"]
        : chosen === "directP2P"
        ? ["onionRouter", "selfOnion"]
        : config.mode === "selfOnion" && chosen === "selfOnion"
          ? ["onionRouter"]
          : [];
    for (const fallbackKind of fallbackKinds) {
      const maxAttempts = fallbackKind === "selfOnion" ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await attemptSend(fallbackKind, {
            allowDirectWhenOnionGuarded: allowDirectFallback && fallbackKind === "directP2P",
            allowSelfOnionWhenOnionGuarded:
              allowSelfOnionFallback && fallbackKind === "selfOnion",
          });
          debugLog("[net] sendOutboxRecord: fallback ok", {
            convId: record.convId,
            messageId: record.id,
            transport: fallbackKind,
          });
          return { ok: true as const };
        } catch (fallbackError) {
          const fallbackErrorMessage = toErrorMessage(fallbackError);
          const shouldRetrySelfOnion =
            fallbackKind === "selfOnion" &&
            attempt < maxAttempts &&
            isSelfOnionRouteNotReadyError(fallbackErrorMessage);
          if (shouldRetrySelfOnion) {
            debugLog("[net] sendOutboxRecord: fallback retry", {
              convId: record.convId,
              messageId: record.id,
              fallbackKind,
              attempt,
              maxAttempts,
              error: fallbackErrorMessage,
            });
            await wait(SELF_ONION_RETRY_DELAY_MS);
            continue;
          }
          controller.reportSendFail(fallbackKind);
          debugLog("[net] sendOutboxRecord: fallback failed", {
            convId: record.convId,
            messageId: record.id,
            fallbackKind,
            error: fallbackErrorMessage,
          });
          break;
        }
      }
    }
    return { ok: false as const, retryable: true };
  }
};

export const onIncomingPacket = (
  handler: (packet: TransportPacket, meta: IncomingPacketMeta) => void
) => {
  inboundHandlers.add(handler);
  void ensureInboundListener();
  return () => {
    inboundHandlers.delete(handler);
  };
};
