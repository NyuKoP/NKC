import { captureLocalOperationContext, openReceiveContext, type ReceiveContext } from "../../accounts/receiveContext";
import { receiveSucceeded } from "../../sync/receiveCompletion";
import type { PacketHandler } from "./types";
import type { HttpClient } from "../../net/httpClient";
import type { NetConfig } from "../../net/netConfig";
import { OnionInboxClient } from "../../net/onionInboxClient";
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Url,
} from "../../security/base64url";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { getOnionControllerUrlOverride, getRoutePolicy } from "../../security/preferences";
import { createId } from "../../utils/ids";
import type { RouteMode } from "../../main/routePolicy";
import { TorRuntime } from "../../net/tor/TorRuntime";
import { createTransportError } from "../../net/transportErrors";
import { emitFlowTraceLog } from "../../diagnostics/infoCollectionLogs";
import type { Transport, TransportPacket, TransportState } from "./types";
import { decodeInboxTransportPacket, encodeBinaryTransportPacket, prioritizeSessionControls } from "./packetCodec";
import { firstMessageMeasurement } from "../../diagnostics/coldStartMetrics";
import { countSessionStage } from "../../diagnostics/sessionInvestigation";

type Handler<T> = (payload: T) => void;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_SEEN_IDS = 500;

const STATE_DEBOUNCE_MS = 1000;

const START_HEALTH_RETRY_DELAYS_MS = [0, 350, 900] as const;

const SEND_PROXY_RETRY_DELAYS_MS = [0, 250, 700] as const;

const ONION_V3_HOST_PATTERN = /^[a-z2-7]{56}\.onion$/;

type OnionFetchRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
};

type OnionFetchResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
};

type TorStatusResponse = {
  state?: unknown;
  socksProxyUrl?: unknown;
};

const isForwardProxyNotReadyError = (message: string) => {
  const text = message.toLowerCase();

  return (
    text.includes("forward_failed:proxy_unreachable") ||
    text.includes("forward_failed:no_proxy")
  );
};

const isForwardNoRouteError = (message: string) => {
  const text = message.toLowerCase();

  return text.includes("forward_failed:no_route") && !text.includes("forward_failed:no_route_target");
};

const createRouteError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const normalizeSocksProxyUrl = (raw: unknown) =>
  typeof raw === "string" && raw.trim() ? raw.trim() : null;

const syncOnionForwardProxyFromRuntime = async (verifyReachable = false) => {
  const nkc = (
    globalThis as {
      nkc?: {
        getTorStatus?: () => Promise<unknown>;
        setOnionForwardProxy?: (proxyUrl: string | null) => Promise<unknown>;
        checkSocksProxyReachable?: (payload: { socksUrl: string; timeoutMs: number }) => Promise<boolean>;
      };
    }
  ).nkc;

  if (!nkc?.getTorStatus || !nkc?.setOnionForwardProxy) {
    return false;
  }

  try {
    const status = (await nkc.getTorStatus()) as TorStatusResponse;

    if (status?.state !== "running") {
      return false;
    }

    const socksProxyUrl = normalizeSocksProxyUrl(status.socksProxyUrl);

    if (!socksProxyUrl) {
      return false;
    }

    if (verifyReachable && !(await nkc.checkSocksProxyReachable?.({ socksUrl: socksProxyUrl, timeoutMs: 2000 }))) {
      return false;
    }

    await nkc.setOnionForwardProxy(socksProxyUrl);

    return true;
  } catch {
    return false;
  }
};

const extractAbortSignal = (packet: TransportPacket) =>
  (packet).signal ??
  (packet).meta?.signal ??
  (packet).route?.signal;

type SendRoute = {
  mode: RouteMode;
  torOnion?: string;
  inboxWriteToken?: string;
};

const normalizeSendRoute = (route: SendRoute): SendRoute =>
  route.torOnion ? { ...route, mode: "preferTor" } : route;

const buildRelaxedRoute = (route: SendRoute): SendRoute => {
  const hasTor = Boolean(route.torOnion);

  if (hasTor) {
    return { ...route, mode: "preferTor" };
  }

  return route;
};

export async function onionFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const nkc = (
    globalThis as { nkc?: { onionFetch?: (req: OnionFetchRequest) => Promise<OnionFetchResponse> } }
  ).nkc;

  if (!nkc?.onionFetch) {
    throw new Error("Onion fetch unavailable");
  }

  const headers = new Headers(init.headers ?? {});
  let bodyBase64: string | undefined;

  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      bodyBase64 = encodeBase64(new TextEncoder().encode(init.body));
    } else if (init.body instanceof Uint8Array) {
      bodyBase64 = encodeBase64(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bodyBase64 = encodeBase64(new Uint8Array(init.body));
    } else {
      throw new Error("Unsupported onion fetch body");
    }
  }

  const response = await nkc.onionFetch({
    url,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    bodyBase64,
    timeoutMs: init.timeoutMs,
  });

  if (response.status === 0) {
    throw new Error(response.error || "Onion fetch failed");
  }

  const body = response.bodyBase64 ? decodeBase64(response.bodyBase64) : new Uint8Array();
  const respHeaders = new Headers(response.headers ?? {});

  return new Response(body, { status: response.status, headers: respHeaders });
}

type OnionRouterOptions = {
  receiveAuthority?: number;
  httpClient: HttpClient;
  config: NetConfig;
  torRuntime?: Pick<TorRuntime, "start" | "awaitReady" | "markDegraded"> & {
    recover?: TorRuntime["recover"];
  };
};

const MAX_PROCESS_WIDE_ACK_IDS = 10_000;

const claimedDeliveryAckIds = new Set<string>();

const claimedDeliveryAckOrder: string[] = [];

const appliedDeliveryAckIds = new Set<string>();

const appliedDeliveryAckOrder: string[] = [];

const rememberProcessWideId = (
  ids: Set<string>,
  order: string[],
  id: string
) => {
  if (ids.has(id)) return false;
  ids.add(id);
  order.push(id);

  if (order.length > MAX_PROCESS_WIDE_ACK_IDS) {
    const overflow = order.splice(0, order.length - MAX_PROCESS_WIDE_ACK_IDS);
    overflow.forEach((oldId) => ids.delete(oldId));
  }

  return true;
};

const releaseProcessWideId = (
  ids: Set<string>,
  order: string[],
  id: string
) => {
  if (!ids.delete(id)) return;
  const index = order.indexOf(id);

  if (index >= 0) order.splice(index, 1);
};

const releaseDeliveryAckClaim = (messageId: string) =>
  releaseProcessWideId(
    claimedDeliveryAckIds,
    claimedDeliveryAckOrder,
    messageId
  );

export const __testResetOnionDeliveryClaims = () => {
  claimedDeliveryAckIds.clear();
  claimedDeliveryAckOrder.length = 0;
  appliedDeliveryAckIds.clear();
  appliedDeliveryAckOrder.length = 0;
};

export const createOnionRouterTransport = ({
  receiveAuthority = 100,
  httpClient,
  config,
  torRuntime: torRuntimeOverride,
}: OnionRouterOptions): Transport => {
  const torRuntime = torRuntimeOverride ?? TorRuntime.getInstance();
  let state: TransportState = "idle";
  let client: OnionInboxClient | null = null;
  let localReplyRoute: TransportPacket["replyRoute"] | null = null;
  let localMailboxToken: string | undefined;
  let startupContext: ReceiveContext | undefined;
  let pollerStop: (() => void) | null = null;
  let errorStreak = 0;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let ackDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;

  let ackDiagnostic: {
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    lastError: string | undefined;
    lastSkipReason: string | undefined;
  } = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    lastError: undefined,
    lastSkipReason: undefined,
  };

  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  const messageHandlers: Array<{ handler: PacketHandler; authority?: number }> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  const flushAckDiagnostics = () => {
    ackDiagnosticTimer = null;

    const total =
      ackDiagnostic.attempted + ackDiagnostic.succeeded +
      ackDiagnostic.failed + ackDiagnostic.skipped;

    if (total === 0) return;
    emitFlowTraceLog({
      event: "onionAck:summary",
      attempted: ackDiagnostic.attempted,
      succeeded: ackDiagnostic.succeeded,
      failed: ackDiagnostic.failed,
      skipped: ackDiagnostic.skipped,
      lastError: ackDiagnostic.lastError,
      lastSkipReason: ackDiagnostic.lastSkipReason,
      level: ackDiagnostic.failed > 0 || ackDiagnostic.skipped > 0 ? "warn" : undefined,
    });
    ackDiagnostic = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      lastError: undefined,
      lastSkipReason: undefined,
    };
  };

  const scheduleAckDiagnosticFlush = () => {
    if (ackDiagnosticTimer) return;
    ackDiagnosticTimer = setTimeout(flushAckDiagnostics, 500);
  };

  const recordAckDiagnostic = (
    kind: "attempted" | "succeeded" | "failed" | "skipped",
    detail?: string
  ) => {
    ackDiagnostic[kind] += 1;

    if (kind === "failed") ackDiagnostic.lastError = detail;

    if (kind === "skipped") ackDiagnostic.lastSkipReason = detail;

    // Keep the attempt and its asynchronous result in the same summary. A
    // skipped ACK has no asynchronous result, so it can be flushed directly.
    if (kind !== "attempted") scheduleAckDiagnosticFlush();
  };

  const requestState = (next: TransportState, immediate = false) => {
    if (state === next) return;

    const flipFlop =
      (state === "connected" && next === "degraded") ||
      (state === "degraded" && next === "connected");

    if (!immediate && flipFlop) {
      if (stateTimer) clearTimeout(stateTimer);
      stateTimer = setTimeout(() => {
        stateTimer = null;
        emitState(next);
      }, STATE_DEBOUNCE_MS);

      return;
    }

    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }

    emitState(next);
  };

  const rememberId = (id: string) => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);

    if (seenOrder.length > MAX_SEEN_IDS) {
      const overflow = seenOrder.splice(0, seenOrder.length - MAX_SEEN_IDS);
      overflow.forEach((oldId) => seenIds.delete(oldId));
    }

    return true;
  };

  const updateStateForError = () => {
    if (errorStreak >= 6) {
      requestState("failed", true);
    } else if (errorStreak >= 3) {
      requestState("degraded");
    }
  };

  const decodeEnvelope = decodeInboxTransportPacket;

  const ensureTorReady = async (signal?: AbortSignal) => {
    try {
      await torRuntime.start({ timeoutMs: 15_000 });
      await torRuntime.awaitReady(15_000, signal);
      await syncOnionForwardProxyFromRuntime();
    } catch {
      throw createRouteError("TOR_NOT_READY", "TOR_NOT_READY: Tor runtime is not ready");
    }
  };

  const recoverTorProxyInBackground = (result: { queued?: boolean; error?: string }) => {
    if (!result.queued || !result.error || !isForwardProxyNotReadyError(result.error)) return;
    void syncOnionForwardProxyFromRuntime(true).then((resynced) => {
      if (resynced) return;
      torRuntime.markDegraded("proxy_unreachable", result.error);

      if (!torRuntime.recover) return;

      return torRuntime.recover({ timeoutMs: 30_000 }).catch((error) => {
        torRuntime.markDegraded("proxy_recovery_failed", error);
      });
    });
  };

  const resolveControllerUrl = async () => {
    const nkc = (
      globalThis as { nkc?: { getOnionControllerUrl?: () => Promise<string> } }
    ).nkc;

    let localUrl = "";

    if (nkc?.getOnionControllerUrl) {
      try {
        localUrl = await nkc.getOnionControllerUrl();
      } catch {
        localUrl = "";
      }
    }

    const override = (await getOnionControllerUrlOverride()).trim();

    if (override) return override;

    if (localUrl) return localUrl;

    return "http://127.0.0.1:3210";
  };

  const refreshLocalReplyRoute = async () => {
    const context = startupContext;
    await context?.vault.assertMain();

    const nkc = (
      globalThis as {
        nkc?: {
          getMyOnionAddress?: () => Promise<string>;
        };
      }
    ).nkc;

    let localOnionAddress = "";

    try {
      localOnionAddress = (await nkc?.getMyOnionAddress?.())?.trim().toLowerCase() ?? "";
    } catch {
      localOnionAddress = "";
    }

    if (!localOnionAddress || !localMailboxToken) {
      localReplyRoute = null;

      return;
    }

    localReplyRoute = {
      toDeviceId: getOrCreateDeviceId(context),
      torOnion: localOnionAddress,
      inboxWriteToken: localMailboxToken,
      sentAt: 0,
    };
    await context?.vault.assertMain();
  };

  const sendDeliveryAck = async (packet: TransportPacket, context?: ReceiveContext) => {
    await context?.vault.assertMain();

    if (
      !rememberProcessWideId(
        claimedDeliveryAckIds,
        claimedDeliveryAckOrder,
        packet.id
      )
    ) {
      return;
    }

    const activeClient = client;
    const replyRoute = packet.replyRoute;

    if (!activeClient) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "client-unavailable");

      return;
    }

    if (!replyRoute) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "reply-route-missing");

      return;
    }

    if (typeof replyRoute.toDeviceId !== "string" || !replyRoute.toDeviceId.trim()) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "reply-device-missing");

      return;
    }

    if (
      typeof replyRoute.torOnion !== "string" ||
      !ONION_V3_HOST_PATTERN.test(replyRoute.torOnion)
    ) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "reply-onion-invalid");

      return;
    }

    if (
      typeof replyRoute.inboxWriteToken !== "string" ||
      !replyRoute.inboxWriteToken.trim()
    ) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "reply-capability-missing");

      return;
    }

    if (typeof replyRoute.sentAt !== "number" || !Number.isFinite(replyRoute.sentAt)) {
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("skipped", "reply-timestamp-invalid");

      return;
    }

    const ackPacket: TransportPacket = {
      id: createId(),
      payload: "",
      deliveryAck: {
        messageId: packet.id,
        sentAt: replyRoute.sentAt,
      },
    };

    const envelope = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify(ackPacket))
    );

    const route = replyRoute.torOnion
      ? {
          mode: "preferTor" as const,
          torOnion: replyRoute.torOnion,
          inboxWriteToken: replyRoute.inboxWriteToken,
        }
      : undefined;

    recordAckDiagnostic("attempted");

    try {
      await context?.vault.assertMain();

      const result = await activeClient.send(
        replyRoute.toDeviceId,
        envelope,
        DEFAULT_TTL_MS,
        route,
        undefined,
        ackPacket.id
      );

      if (result.ok) {
        recordAckDiagnostic("succeeded");

        return;
      }

      const error = result.error ?? "ack-send-failed";
      releaseDeliveryAckClaim(packet.id);
      recordAckDiagnostic("failed", error);
      console.warn("[net][ack] failed to return delivery acknowledgement", {
        messageId: packet.id,
        error,
      });
    } catch (error) {
      releaseDeliveryAckClaim(packet.id);
      const message = error instanceof Error ? error.message : String(error);
      recordAckDiagnostic("failed", message);
      throw error;
    }
  };

  const handlePollSuccess = async (result: Awaited<ReturnType<OnionInboxClient["poll"]>>) => {
    errorStreak = 0;

    if (state === "degraded" || state === "failed") {
      requestState("connected");
    }

    let decodedCount = 0;
    let decodeFailedCount = 0;
    let messageCount = 0;
    let deliveryAckCount = 0;
    let totalEnvelopeBytes = 0;
    let maxEnvelopeBytes = 0;
    const completedItems: string[] = [];

    for (const item of prioritizeSessionControls(result.items)) {
      countSessionStage("poll", "input");
      const envelopeBytes = item.envelope.length;
      totalEnvelopeBytes += envelopeBytes;
      maxEnvelopeBytes = Math.max(maxEnvelopeBytes, envelopeBytes);
      countSessionStage("decode", "input");
      const packet = decodeEnvelope(item.envelope);

      if (packet) firstMessageMeasurement.stage(packet.id, "decoded");

      if (!packet) {
        countSessionStage("decode", "rejected");
        decodeFailedCount += 1;
        continue;
      }

      decodedCount += 1;
      countSessionStage("decode", "success");
      countSessionStage("owner", "input");
      const opened = await openReceiveContext(item.localOwner);

      if ("status" in opened) { countSessionStage("owner", "rejected"); continue; }

      countSessionStage("owner", "success");
      const context = opened;

      if (packet.deliveryAck) {
        deliveryAckCount += 1;
        const { messageId, sentAt } = packet.deliveryAck;

        // This legacy frame confirms transport activity, never authenticated plaintext storage.
        // Owned production consumes only valid control fields; no delivery/outbox writer runs.
        if (typeof window !== "undefined" && window.nkc?.activateAccountSession) {
          if (typeof messageId === "string" && messageId.trim() && messageId.length <= 256 &&
              typeof sentAt === "number" && Number.isFinite(sentAt)) {
            await context.vault.assertMain();
            completedItems.push(item.id);
          }

          continue;
        }

        if (
          ackHandlers.length > 0 &&
          typeof messageId === "string" &&
          messageId.trim() &&
          typeof sentAt === "number" &&
          Number.isFinite(sentAt) &&
          rememberProcessWideId(
            appliedDeliveryAckIds,
            appliedDeliveryAckOrder,
            messageId
          )
        ) {
          const rttMs = Math.max(0, Date.now() - sentAt);
          ackHandlers.forEach((handler) => handler({ id: messageId, rttMs }));
        }

        // Incoming ACK completion is not yet certified by its void callbacks.
        continue;
      }

      messageCount += 1;

      // Even a remembered ID requires the existing owner vault to verify a duplicate.
      try {
        const highest = Math.max(...messageHandlers.map(entry => Number.isFinite(entry.authority) ? entry.authority! : -Infinity));
        const selected = messageHandlers.filter(entry => Number.isFinite(entry.authority) && entry.authority === highest);
        countSessionStage("dispatcher", selected.length === 1 ? "input" : "missing");

        const completion = (selected.length === 1 ? await selected[0].handler(packet, context,
          item.envelope instanceof Uint8Array ? item.envelope : undefined) : undefined) ?? undefined;

        countSessionStage("dispatcher", receiveSucceeded(completion) ? "success" : completion?.status === "OWNED_DEFERRED" ? "deferred" : "rejected");

        for (const observer of messageHandlers.filter(entry => entry.authority === undefined)) {
          void Promise.resolve().then(() => observer.handler(packet, context)).catch(() => {});
        }

        await context.vault.assertMain();

        if (!receiveSucceeded(completion) || !completion || !("accountId" in completion) ||
            completion.accountId !== context.owner.accountId) continue;
        rememberId(item.id);
        await sendDeliveryAck(packet, context);
        completedItems.push(item.id);
      } catch { countSessionStage("dispatcher", "error"); /* No positive completion: retain this item. */ }
    }

    if (result.items.length > 0) {
      emitFlowTraceLog({
        event: "onionInbox:batch",
        itemCount: result.items.length,
        decodedCount,
        decodeFailedCount,
        messageCount,
        deliveryAckCount,
        totalEnvelopeBytes,
        maxEnvelopeBytes,
        nextAfterPresent: Boolean(result.nextAfter),
        level: decodeFailedCount > 0 ? "warn" : undefined,
      });
    }

    return completedItems;
  };

  const handlePollError = () => {
    errorStreak += 1;
    updateStateForError();
  };

  return {
    name: "onionRouter",
    async start() {
      const context = await captureLocalOperationContext();
      startupContext = context;
      void httpClient;
      requestState("connecting", true);

      if (config.onionSelectedNetwork === "tor") {
        try {
          countSessionStage("tor-ready", "input");
          await ensureTorReady();
          countSessionStage("tor-ready", "success");
        } catch {
          requestState("failed", true);
          throw createRouteError("TOR_NOT_READY", "TOR_NOT_READY: Tor runtime is not ready");
        }
      }

      countSessionStage("controller-url", "input");
      const baseUrl = await resolveControllerUrl();
      countSessionStage("controller-url", "success");
      const localDeviceId = getOrCreateDeviceId(context);
      const receiveSession = context?.owner.session ?? await acquireMainAccountSession(getActiveAccountId());
      await context?.vault.assertMain();
      let mailboxToken: string | undefined;

      const nkc = (
        globalThis as {
          nkc?: {
            getMyOnionAddress?: () => Promise<string>;
            registerOnionMailbox?: (
              deviceId: string, session?: import("../../accounts/mainSessionTypes").MainAccountSession
            ) => Promise<{ ok: boolean; inboxWriteToken?: string; error?: string }>;
          };
        }
      ).nkc;

      if (nkc?.registerOnionMailbox) {
        countSessionStage("mailbox", "input");

        const mailbox = await nkc.registerOnionMailbox(localDeviceId,
          receiveSession);

        countSessionStage("mailbox", mailbox.ok ? "success" : "rejected");

        if (!mailbox.ok) {
          throw new Error(mailbox.error ?? "mailbox-registration-failed");
        }

        mailboxToken = mailbox.inboxWriteToken;
      }

      localMailboxToken = mailboxToken;
      countSessionStage("reply-route", "input");
      await refreshLocalReplyRoute();
      countSessionStage("reply-route", "success");
      client = new OnionInboxClient({
        receiveSession,
        baseUrl,
        deviceId: localDeviceId,
        mailboxToken,
      });
      countSessionStage("controller-health", "input");
      let health = await client.health();
      countSessionStage("controller-health", health.ok ? "success" : "rejected");

      for (const delayMs of START_HEALTH_RETRY_DELAYS_MS.slice(1)) {
        if (health.ok) break;
        await wait(delayMs);
        health = await client.health();
      }

      if (!health.ok) {
        requestState("failed", true);
        throw new Error(health.details ?? "Onion controller unavailable");
      }

      requestState("connected", true);
      await context?.vault.assertMain();
      pollerStop = client.startPolling(
        {
          onResult: handlePollSuccess,
          authority: receiveAuthority,
          onError: handlePollError,
        },
        { limit: 50 }
      ).stop;
    },
    async stop() {
      if (pollerStop) {
        pollerStop();
        pollerStop = null;
      }

      if (stateTimer) {
        clearTimeout(stateTimer);
        stateTimer = null;
      }

      if (ackDiagnosticTimer) {
        clearTimeout(ackDiagnosticTimer);
        flushAckDiagnostics();
      }

      errorStreak = 0;
      seenIds.clear();
      seenOrder.length = 0;
      client = null;
      localReplyRoute = null;
      localMailboxToken = undefined;
      startupContext = undefined;
      requestState("idle", true);
    },
    async send(packet: TransportPacket) {
      const context = startupContext;
      await context?.vault.assertMain();
      const signal = extractAbortSignal(packet);

      const torOnion =
        (packet).torOnion ??
        (packet).toOnion ??
        (packet).route?.torOnion ??
        (packet).route?.toOnion ??
        (packet).meta?.torOnion ??
        (packet).meta?.toOnion;

      const inboxWriteToken =
        (packet).route?.inboxWriteToken ??
        (packet).meta?.inboxWriteToken;

      const routeMode =
        ((packet).route?.mode ??
          (packet).meta?.routeMode ??
          (packet).meta?.routePolicy) ??
        (await getRoutePolicy());

      const toDeviceId =
        (packet).toDeviceId ??
        (packet).meta?.toDeviceId ??
        (packet).route?.toDeviceId ??
        (packet).to ??
        (packet).route?.to ??
        (packet).meta?.to;

      if (!toDeviceId || !toDeviceId.trim()) {
        console.warn(
          `[net][route] missing_to skip route=onionRouter opId=${(packet).id ?? "unknown"}`
        );
        throw createTransportError("FATAL_MISCONFIG", "FATAL_MISCONFIG: missing destination 'to'");
      }

      const initialRoute =
        torOnion
          ? {
              mode: routeMode,
              torOnion,
              inboxWriteToken,
            }
          : undefined;

      let route = initialRoute ? normalizeSendRoute(initialRoute) : undefined;
      await ensureTorReady(signal);

      if (signal?.aborted) {
        throw createRouteError("TOR_NOT_READY", "TOR_NOT_READY: send aborted");
      }

      if (!client) {
        throw new Error("Onion controller is not ready");
      }

      if (!localReplyRoute) {
        await refreshLocalReplyRoute();
      }

      const activeClient = client;

      const wirePacket: TransportPacket = localReplyRoute
        ? {
            ...packet,
            replyRoute: {
              ...localReplyRoute,
              sentAt: Date.now(),
            },
          }
        : packet;

      const binaryPacket = encodeBinaryTransportPacket(wirePacket);

      const envelope = encodeBase64Url(
        binaryPacket ?? new TextEncoder().encode(JSON.stringify(wirePacket))
      );

      const sendOnce = async () => {
        await context?.vault.assertMain();

        if (client !== activeClient) throw new Error("OWNER_TRANSPORT_REPLACED");

        return activeClient.send(toDeviceId, envelope, DEFAULT_TTL_MS, route, signal, packet.id);
      };

      if (!torOnion) {
        let result = await sendOnce();

        if (!result.ok) {
          const message = result.error ?? "Onion send failed";

          if (isForwardProxyNotReadyError(message)) {
            const resynced = await syncOnionForwardProxyFromRuntime();

            if (resynced) {
              result = await sendOnce();
            }

            if (!result.ok) {
              const fallbackMessage = result.error ?? message;
              torRuntime.markDegraded("proxy_unreachable", fallbackMessage);
              throw createRouteError("PROXY_UNREACHABLE", `PROXY_UNREACHABLE: ${fallbackMessage}`);
            }

            if (result.queued) return { handoff: "offline-queue" as const };

            return { handoff: "mailbox" as const };
          }

          throw new Error(message);
        }

        recoverTorProxyInBackground(result);

        if (result.queued) return { handoff: "offline-queue" as const };

        return { handoff: "mailbox" as const };
      }

      let lastError = "Onion send failed";
      let relaxedRouteTried = false;
      let proxyResynced = false;

      for (const delayMs of SEND_PROXY_RETRY_DELAYS_MS) {
        if (signal?.aborted) {
          throw createRouteError("TOR_NOT_READY", "TOR_NOT_READY: send aborted");
        }

        if (delayMs > 0) {
          await wait(delayMs);
        }

        const result = await sendOnce();

        if (result.ok) {
          recoverTorProxyInBackground(result);

          if (result.queued) return { handoff: "offline-queue" as const };

          return { handoff: "mailbox" as const };
        }

        lastError = result.error ?? "Onion send failed";

        if (
          route &&
          !relaxedRouteTried &&
          isForwardNoRouteError(lastError)
        ) {
          route = buildRelaxedRoute(route);
          relaxedRouteTried = true;
          continue;
        }

        if (isForwardProxyNotReadyError(lastError) && !proxyResynced) {
          proxyResynced = await syncOnionForwardProxyFromRuntime();

          if (proxyResynced) {
            continue;
          }
        }

        if (!isForwardProxyNotReadyError(lastError)) {
          break;
        }
      }

      if (isForwardProxyNotReadyError(lastError)) {
        torRuntime.markDegraded("proxy_unreachable", lastError);
        throw createRouteError("PROXY_UNREACHABLE", `PROXY_UNREACHABLE: ${lastError}`);
      }

      throw new Error(lastError);
    },
    onMessage(cb, options = { authority: 0 }) {
      messageHandlers.push({ handler: cb, authority: options.authority });
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

import { acquireMainAccountSession } from "../../accounts/accountOwnerLifecycle";
import { getActiveAccountId } from "../../accounts/accountRegistry";
