import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { TorStatus } from "./torManager";
import type { alternateRouteStatus } from "./alternateRouteManager";
import { clearSocksAgentPool, socksFetch } from "./socksHttpClient";
import { normalizeRouteTarget, selectRoute, type RouteMode } from "./routePolicy";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { appendTestLogRecord } from "./testLogStore";

type InboxItem = {
  id: string;
  ts: number;
  from: string;
  envelope: string;
  expiresAt: number;
};

type InboxState = {
  baseIndex: number;
  bytes: number;
  items: InboxItem[];
};

type ForwardingState = {
  proxyUrl: string | null;
  ready: boolean;
};

export type OnionControllerHandle = {
  baseUrl: string;
  port: number;
  authToken: string;
  setTorSocksProxy: (proxyUrl: string | null) => Promise<void>;
  setalternateRouteSocksProxy: (proxyUrl: string | null) => Promise<void>;
  setTorOnionHost: (host: string | null) => void;
  setalternateRouteAddress: (address: string | null) => void;
  prewarmTorRoute: (onionAddress: string) => Promise<{ ok: boolean; elapsedMs: number; error?: string }>;
  close: () => Promise<void>;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_INBOX_BYTES = 64 * 1024 * 1024;
const MAX_DEVICE_INBOX_BYTES = 32 * 1024 * 1024;
const MAX_INBOX_ITEMS = 4096;
const MAX_DEVICE_INBOX_ITEMS = 2048;
const INGEST_RATE_WINDOW_MS = 1000;
const MAX_INGESTS_PER_WINDOW = 120;
const FORWARD_TIMEOUT_MS = 45_000;
const FORWARD_RETRY_ATTEMPTS = 1;
const FORWARD_RETRY_DELAY_MS = 350;
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<{ ok: boolean; body?: string; error?: string }>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (payload: { ok: boolean; body?: string; error?: string }) => {
      if (done) return;
      done = true;
      resolve(payload);
    };
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: "body-too-large" });
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ ok: false, error: "read-error" }));
  });

export type OnionSendPayload = {
  to?: string;
  from?: string;
  envelope?: string;
  ttlMs?: number;
  toDeviceId?: string;
  toOnion?: string;
  fromDeviceId?: string;
  route?: {
    mode?: RouteMode;
    torOnion?: string;
    alternateRoute?: string;
  };
};

type OnionSendDeps = {
  socksFetch: typeof socksFetch;
  selectRoute: typeof selectRoute;
  now: () => number;
  uuid: () => string;
  torProxyUrl: string | null;
  alternateRouteProxyUrl: string | null;
  storeLocal: (
    deviceId: string,
    item: Omit<InboxItem, "expiresAt"> & { ttlMs?: number }
  ) => boolean | void;
  enqueueOfflineMessage?: (item: {
    id: string;
    friendId: string;
    onionAddress: string;
    payload: string;
    createdAt: number;
  }) => Promise<void>;
  emitTrace?: (detail: {
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    [key: string]: unknown;
  }) => void;
};

const normalizeForwardError = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "timeout" || code === "proxy_unreachable" || code === "handshake_failed" || code === "upstream_error") {
    return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  if (text.includes("timeout")) return "timeout";
  if (
    text.includes("socks_auth_failed") ||
    text.includes("socks_connect_failed") ||
    text.includes("unsupported_socks_protocol") ||
    text.includes("invalid_socks_proxy") ||
    text.includes("socks_auth_unsupported")
  ) {
    return "handshake_failed";
  }
  if (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("ehostunreach") ||
    text.includes("econnreset") ||
    text.includes("connect_fail")
  ) {
    return "proxy_unreachable";
  }
  return "upstream_error";
};

const summarizeProxy = (proxyUrl: string | null) => {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    return {
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname || null,
      port: parsed.port || null,
    };
  } catch {
    return {
      protocol: "invalid",
      host: null,
      port: null,
    };
  }
};

const serializeForwardError = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const stackTop =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\n").slice(0, 2).join("\n")
      : undefined;
  return {
    code: code || undefined,
    message,
    stackTop,
  };
};

export const handleOnionSend = async (payload: OnionSendPayload, deps: OnionSendDeps) => {
  const emitTrace = deps.emitTrace ?? ((detail) => emitFlowTraceLog(detail));
  if (!payload || typeof payload !== "object" || typeof payload.envelope !== "string" || !payload.envelope) {
    return { status: 400, body: { ok: false, error: "missing-fields" } };
  }
  const msgId = deps.uuid();
  const ts = deps.now();
  const toOnion =
    payload.toOnion ??
    payload.route?.torOnion ??
    (payload.to?.includes(".onion") ? payload.to : undefined);
  const toDeviceId = payload.toDeviceId ?? payload.to;
  const fromDeviceId = payload.fromDeviceId ?? payload.from ?? "";
  const routeMode = payload.route?.mode ?? "manual";
  const alternateRouteAddress = payload.route?.alternateRoute;

  if (!(["auto", "preferalternateRoute", "preferTor", "manual"] as const).includes(routeMode)) {
    return { status: 400, body: { ok: false, error: "invalid-route-mode" } };
  }
  if (typeof toDeviceId !== "string" || !toDeviceId) {
    return { status: 400, body: { ok: false, error: "missing-to-device" } };
  }
  if (
    toDeviceId.length > 256 ||
    typeof fromDeviceId !== "string" ||
    fromDeviceId.length > 256
  ) {
    return { status: 400, body: { ok: false, error: "invalid-device-id" } };
  }

  if (
    (toOnion && !normalizeRouteTarget("tor", toOnion)) ||
    (alternateRouteAddress && !normalizeRouteTarget("alternateRoute", alternateRouteAddress))
  ) {
    return { status: 400, body: { ok: false, error: "invalid-route-target" } };
  }

  const hasRouteTargets = Boolean(toOnion || alternateRouteAddress);
  if (payload.route || hasRouteTargets) {
    let offlineQueueReason: string | null = null;
    let terminalFailure: { status: number; body: { ok: false; error: string } } | null = null;
    const queueTorPending = async (error: string) => {
      if (!toOnion || !deps.enqueueOfflineMessage) return null;
      await deps.enqueueOfflineMessage({
        id: msgId,
        friendId: toDeviceId,
        onionAddress: toOnion,
        payload: payload.envelope ?? "",
        createdAt: ts,
      });
      emitTrace({
        event: "onionController:offlineQueue:pending",
        level: "warn",
        opId: msgId,
        toDeviceId,
        destination: toOnion,
        reason: error,
      });
      return {
        status: 202,
        body: {
          ok: true,
          msgId,
          forwarded: false,
          queued: true,
          status: "PENDING",
          error,
        },
      };
    };
    const candidates = deps.selectRoute(
      routeMode,
      {
        torOnion: toOnion,
        alternateRoute: alternateRouteAddress,
      },
      {
        tor: Boolean(deps.torProxyUrl),
        alternateRoute: Boolean(deps.alternateRouteProxyUrl),
      }
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const isLast = index === candidates.length - 1;
      const proxyUrl = candidate.kind === "tor" ? deps.torProxyUrl : deps.alternateRouteProxyUrl;
      const targetUrl = `${candidate.target}/onion/ingest`;
      const proxySummary = summarizeProxy(proxyUrl);
      if (!proxyUrl) {
        emitTrace({
          event: "onionController:forward:skip",
          level: "warn",
          opId: msgId,
          routeKind: candidate.kind,
          routeMode,
          destination: candidate.target,
          toDeviceId,
          attempt: index + 1,
          maxRouteAttempts: candidates.length,
          reason: "missing-forward-proxy",
        });
        if (candidate.kind === "tor") {
          offlineQueueReason = "forward_failed:no_proxy";
        }
        if (routeMode === "auto") continue;
        terminalFailure = {
          status: 400,
          body: { ok: false, error: "forward_failed:no_proxy" },
        };
        continue;
      }
      try {
        emitTrace({
          event: "onionController:forward:start",
          opId: msgId,
          routeKind: candidate.kind,
          routeMode,
          destination: candidate.target,
          destinationUrl: targetUrl,
          toDeviceId,
          attempt: index + 1,
          maxRouteAttempts: candidates.length,
          socksProxy: proxySummary,
          timeoutMs: FORWARD_TIMEOUT_MS,
          retryAttempts: FORWARD_RETRY_ATTEMPTS,
          retryDelayMs: FORWARD_RETRY_DELAY_MS,
        });
        const response = await deps.socksFetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              toDeviceId,
              from: fromDeviceId,
              envelope: payload.envelope,
              ts,
              id: msgId,
            })
          ),
          timeoutMs: FORWARD_TIMEOUT_MS,
          socksProxyUrl: proxyUrl,
          retry: { attempts: FORWARD_RETRY_ATTEMPTS, delayMs: FORWARD_RETRY_DELAY_MS },
          onAttemptStart: ({ attempt, maxAttempts }) => {
            emitTrace({
              event: "onionController:forward:attempt",
              opId: msgId,
              routeKind: candidate.kind,
              routeMode,
              destination: candidate.target,
              destinationUrl: targetUrl,
              toDeviceId,
              attempt,
              maxAttempts,
              socksProxy: proxySummary,
              timeoutMs: FORWARD_TIMEOUT_MS,
            });
          },
          onAttemptSuccess: ({ attempt, maxAttempts, status }) => {
            emitTrace({
              event: "onionController:forward:attempt_ok",
              opId: msgId,
              routeKind: candidate.kind,
              routeMode,
              destination: candidate.target,
              destinationUrl: targetUrl,
              toDeviceId,
              attempt,
              maxAttempts,
              status,
              socksProxy: proxySummary,
            });
          },
          onAttemptFailure: ({ attempt, maxAttempts, error, retryDelayMs }) => {
            emitTrace({
              event: "onionController:forward:attempt_fail",
              level: "warn",
              opId: msgId,
              routeKind: candidate.kind,
              routeMode,
              destination: candidate.target,
              destinationUrl: targetUrl,
              toDeviceId,
              attempt,
              maxAttempts,
              retryDelayMs,
              socksProxy: proxySummary,
              error: serializeForwardError(error),
            });
          },
        });
        if (response.status >= 200 && response.status < 300) {
          emitTrace({
            event: "onionController:forward:ok",
            opId: msgId,
            routeKind: candidate.kind,
            routeMode,
            destination: candidate.target,
            destinationUrl: targetUrl,
            toDeviceId,
            attempt: index + 1,
            maxRouteAttempts: candidates.length,
            status: response.status,
            socksProxy: proxySummary,
          });
          return { status: 200, body: { ok: true, msgId, forwarded: true, via: candidate.kind } };
        }
        emitTrace({
          event: "onionController:forward:bad_status",
          level: "warn",
          opId: msgId,
          routeKind: candidate.kind,
          routeMode,
          destination: candidate.target,
          destinationUrl: targetUrl,
          toDeviceId,
          attempt: index + 1,
          maxRouteAttempts: candidates.length,
          status: response.status,
          socksProxy: proxySummary,
        });
        if (!isLast && routeMode === "auto") {
          continue;
        }
        const code = normalizeForwardError("upstream_error");
        if (candidate.kind === "tor") {
          offlineQueueReason = `forward_failed:${code}`;
        }
        terminalFailure = {
          status: 502,
          body: { ok: false, error: `forward_failed:${code}` },
        };
        continue;
      } catch (error) {
        const code = normalizeForwardError(error);
        emitTrace({
          event: "onionController:forward:fail",
          level: "warn",
          opId: msgId,
          routeKind: candidate.kind,
          routeMode,
          destination: candidate.target,
          destinationUrl: targetUrl,
          toDeviceId,
          attempt: index + 1,
          maxRouteAttempts: candidates.length,
          normalizedCode: code,
          socksProxy: proxySummary,
          error: serializeForwardError(error),
        });
        if (!isLast && routeMode === "auto") {
          continue;
        }
        if (candidate.kind === "tor") {
          offlineQueueReason = `forward_failed:${code}`;
        }
        terminalFailure = { status: 502, body: { ok: false, error: `forward_failed:${code}` } };
      }
    }
    if (!offlineQueueReason && toOnion && deps.enqueueOfflineMessage && routeMode !== "preferalternateRoute") {
      offlineQueueReason = terminalFailure?.body.error ?? "forward_failed:no_route";
    }
    if (offlineQueueReason) {
      const queued = await queueTorPending(offlineQueueReason);
      if (queued) return queued;
    }
    if (terminalFailure) return terminalFailure;
    return { status: 400, body: { ok: false, error: "forward_failed:no_route" } };
  }

  // Legacy/local fallback is only safe for explicit loopback sends.
  if (fromDeviceId && fromDeviceId !== toDeviceId) {
    return { status: 400, body: { ok: false, error: "forward_failed:no_route_target" } };
  }

  const stored = deps.storeLocal(toDeviceId, {
    id: msgId,
    ts,
    from: fromDeviceId,
    envelope: payload.envelope,
    ttlMs: payload.ttlMs,
  });
  if (stored === false) {
    return { status: 429, body: { ok: false, error: "inbox-capacity-exceeded" } };
  }
  return { status: 200, body: { ok: true, msgId, forwarded: false } };
};

export const startOnionController = async (options?: {
  port?: number;
  getTorStatus?: () => TorStatus;
  getalternateRouteStatus?: () => alternateRouteStatus;
  userDataPath?: string;
  enqueueOfflineMessage?: OnionSendDeps["enqueueOfflineMessage"];
}): Promise<OnionControllerHandle> => {
  const host = "127.0.0.1";
  const port = options?.port ?? 3210;
  const authToken = `${randomUUID()}${randomUUID()}`;
  const inbox = new Map<string, InboxState>();
  let inboxBytes = 0;
  let inboxItems = 0;
  let ingestWindowStartedAt = Date.now();
  let ingestWindowCount = 0;
  const torForwarding: ForwardingState = {
    proxyUrl: null,
    ready: false,
  };
  const alternateRouteForwarding: ForwardingState = {
    proxyUrl: null,
    ready: false,
  };
  const emitControllerTrace = (detail: {
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    [key: string]: unknown;
  }) => {
    emitFlowTraceLog(detail);
    if (!options?.userDataPath) return;
    void appendTestLogRecord(options.userDataPath, {
      channel: "router",
      event: {
        ...detail,
        timestamp: new Date().toISOString(),
      },
    }).catch((error) => {
      console.warn("[test-log] main trace append failed", error);
    });
  };
  let myTorOnionHost: string | null = null;
  let myalternateRouteAddress: string | null = null;
  const setTorSocksProxy = async (proxyUrl: string | null) => {
    const trimmed = proxyUrl?.trim() ?? "";
    const previousProxy = torForwarding.proxyUrl;
    if (previousProxy && previousProxy !== trimmed) clearSocksAgentPool(previousProxy);
    if (!trimmed) {
      torForwarding.proxyUrl = null;
      torForwarding.ready = false;
      return;
    }
    torForwarding.proxyUrl = trimmed;
    torForwarding.ready = true;
  };

  const prewarmTorRoute = async (onionAddress: string) => {
    const startedAt = Date.now();
    const normalized = onionAddress.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (!/^[a-z2-7]{56}\.onion$/.test(normalized)) {
      return { ok: false, elapsedMs: Date.now() - startedAt, error: "invalid-onion-address" };
    }
    if (!torForwarding.ready || !torForwarding.proxyUrl) {
      return { ok: false, elapsedMs: Date.now() - startedAt, error: "tor-proxy-unavailable" };
    }
    try {
      const response = await socksFetch(`http://${normalized}/onion/health`, {
        method: "GET",
        socksProxyUrl: torForwarding.proxyUrl,
        timeoutMs: FORWARD_TIMEOUT_MS,
      });
      const elapsedMs = Date.now() - startedAt;
      return response.status === 200
        ? { ok: true, elapsedMs }
        : { ok: false, elapsedMs, error: `prewarm-http-${response.status}` };
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const setalternateRouteSocksProxy = async (proxyUrl: string | null) => {
    const trimmed = proxyUrl?.trim() ?? "";
    if (!trimmed) {
      alternateRouteForwarding.proxyUrl = null;
      alternateRouteForwarding.ready = false;
      return;
    }
    alternateRouteForwarding.proxyUrl = trimmed;
    alternateRouteForwarding.ready = true;
  };

  const setTorOnionHost = (hostValue: string | null) => {
    const trimmed = hostValue?.trim() ?? "";
    myTorOnionHost = trimmed ? trimmed : null;
  };

  const setalternateRouteAddress = (addressValue: string | null) => {
    const trimmed = addressValue?.trim() ?? "";
    myalternateRouteAddress = trimmed ? trimmed : null;
  };

  const getItemBytes = (item: Pick<InboxItem, "id" | "from" | "envelope">) =>
    Buffer.byteLength(item.id, "utf8") +
    Buffer.byteLength(item.from, "utf8") +
    Buffer.byteLength(item.envelope, "utf8") +
    32;

  const enqueue = (deviceId: string, item: Omit<InboxItem, "expiresAt"> & { ttlMs?: number }) => {
    const ttlMs = item.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = item.ts + ttlMs;
    const entry: InboxItem = { ...item, expiresAt };
    const entryBytes = getItemBytes(entry);
    const state = inbox.get(deviceId) ?? { baseIndex: 0, bytes: 0, items: [] };
    if (
      inboxItems >= MAX_INBOX_ITEMS ||
      state.items.length >= MAX_DEVICE_INBOX_ITEMS ||
      inboxBytes + entryBytes > MAX_INBOX_BYTES ||
      state.bytes + entryBytes > MAX_DEVICE_INBOX_BYTES
    ) {
      return false;
    }
    state.items.push(entry);
    state.bytes += entryBytes;
    inboxBytes += entryBytes;
    inboxItems += 1;
    inbox.set(deviceId, state);
    return true;
  };

  const removeItems = (state: InboxState, count: number) => {
    if (count <= 0) return;
    const removed = state.items.splice(0, count);
    const removedBytes = removed.reduce((total, item) => total + getItemBytes(item), 0);
    state.baseIndex += removed.length;
    state.bytes = Math.max(0, state.bytes - removedBytes);
    inboxBytes = Math.max(0, inboxBytes - removedBytes);
    inboxItems = Math.max(0, inboxItems - removed.length);
  };

  const cleanup = () => {
    const now = Date.now();
    for (const [deviceId, state] of inbox.entries()) {
      const expiredCount = state.items.findIndex((item) => item.expiresAt > now);
      if (expiredCount < 0) {
        removeItems(state, state.items.length);
        inbox.delete(deviceId);
      } else if (expiredCount > 0) {
        removeItems(state, expiredCount);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    if (req.headers.origin || req.method === "OPTIONS") {
      sendJson(res, 403, { ok: false, error: "browser-origin-blocked" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorized = req.headers["x-nkc-controller-token"] === authToken;
    const localOnlyRoute =
      url.pathname === "/onion/address" ||
      url.pathname === "/onion/send" ||
      url.pathname === "/onion/inbox";
    if (localOnlyRoute && !authorized) {
      sendJson(res, 401, { ok: false, error: "controller-auth-required" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/onion/health") {
      const torStatus = options?.getTorStatus ? options.getTorStatus() : null;
      const alternateRouteStatus = options?.getalternateRouteStatus ? options.getalternateRouteStatus() : null;
      const torActive = Boolean(
        torStatus &&
          torStatus.state === "running" &&
          torForwarding.ready &&
          torForwarding.proxyUrl
      );
      const alternateRouteActive = Boolean(
        alternateRouteStatus &&
          alternateRouteStatus.state === "running" &&
          alternateRouteForwarding.ready &&
          alternateRouteForwarding.proxyUrl
      );
      const details = torActive || alternateRouteActive ? "route proxies enabled" : "local-only mode";
      const network = torActive ? "tor" : alternateRouteActive ? "alternateRoute" : "none";
      sendJson(res, 200, authorized ? {
        ok: true,
        network,
        details,
        tor: {
          active: torActive,
          socksProxy: torForwarding.proxyUrl ?? null,
          address: myTorOnionHost ?? undefined,
          details: torStatus?.state,
        },
        alternateRoute: {
          active: alternateRouteActive,
          proxyUrl: alternateRouteForwarding.proxyUrl ?? null,
          address: myalternateRouteAddress ?? undefined,
          details: alternateRouteStatus?.state,
        },
      } : { ok: true, network: torActive ? "tor" : alternateRouteActive ? "alternateRoute" : "none" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/address") {
      sendJson(res, 200, {
        ok: true,
        torOnion: myTorOnionHost ?? undefined,
        alternateRoute: myalternateRouteAddress ?? undefined,
        details:
          myTorOnionHost || myalternateRouteAddress
            ? undefined
            : "address-unavailable",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/send") {
      const parsed = await readBody(req);
      if (!parsed.ok || !parsed.body) {
        sendJson(res, parsed.error === "body-too-large" ? 413 : 400, {
          ok: false,
          error: parsed.error ?? "invalid-body",
        });
        return;
      }
      let payload: OnionSendPayload;
      try {
        payload = JSON.parse(parsed.body) as OnionSendPayload;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });
        return;
      }
      const result = await handleOnionSend(payload, {
        socksFetch,
        selectRoute,
        now: () => Date.now(),
        uuid: () => randomUUID(),
        torProxyUrl: torForwarding.proxyUrl,
        alternateRouteProxyUrl: alternateRouteForwarding.proxyUrl,
        storeLocal: (deviceId, item) => enqueue(deviceId, item),
        enqueueOfflineMessage: options?.enqueueOfflineMessage,
        emitTrace: emitControllerTrace,
      });
      sendJson(res, result.status, result.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/inbox") {
      const deviceId = url.searchParams.get("deviceId") ?? "";
      if (!deviceId) {
        sendJson(res, 400, { ok: false, items: [], nextAfter: null, error: "missing-device" });
        return;
      }
      const afterRaw = url.searchParams.get("after");
      const afterIndex = afterRaw ? Number.parseInt(afterRaw, 10) : -1;
      const limitRaw = url.searchParams.get("limit");
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
      const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 50;
      const state = inbox.get(deviceId) ?? { baseIndex: 0, bytes: 0, items: [] };
      if (Number.isFinite(afterIndex) && afterIndex >= state.baseIndex) {
        removeItems(state, Math.min(state.items.length, afterIndex - state.baseIndex + 1));
      }
      const slice = state.items.slice(0, limit);
      const items = slice.map((item) => ({
        id: item.id,
        ts: item.ts,
        from: item.from,
        envelope: item.envelope,
      }));
      const nextAfter =
        items.length > 0 ? String(state.baseIndex + items.length - 1) : afterRaw ?? null;
      sendJson(res, 200, { ok: true, items, nextAfter });
      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/ingest") {
      const now = Date.now();
      if (now - ingestWindowStartedAt >= INGEST_RATE_WINDOW_MS) {
        ingestWindowStartedAt = now;
        ingestWindowCount = 0;
      }
      ingestWindowCount += 1;
      if (ingestWindowCount > MAX_INGESTS_PER_WINDOW) {
        sendJson(res, 429, { ok: false, error: "ingest-rate-limited" });
        return;
      }
      const parsed = await readBody(req);
      if (!parsed.ok || !parsed.body) {
        sendJson(res, parsed.error === "body-too-large" ? 413 : 400, {
          ok: false,
          error: parsed.error ?? "invalid-body",
        });
        return;
      }
      let payload: {
        toDeviceId?: string;
        from?: string;
        envelope?: string;
        ts?: number;
        id?: string;
      };
      try {
        payload = JSON.parse(parsed.body) as {
          toDeviceId?: string;
          from?: string;
          envelope?: string;
          ts?: number;
          id?: string;
        };
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });
        return;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.toDeviceId !== "string" ||
        !payload.toDeviceId ||
        payload.toDeviceId.length > 256 ||
        typeof payload.envelope !== "string" ||
        !payload.envelope ||
        (payload.from !== undefined &&
          (typeof payload.from !== "string" || payload.from.length > 256)) ||
        (payload.id !== undefined &&
          (typeof payload.id !== "string" || !payload.id || payload.id.length > 128))
      ) {
        sendJson(res, 400, { ok: false, error: "missing-fields" });
        return;
      }
      const msgId = payload.id ?? randomUUID();
      const ts = Date.now();
      const accepted = enqueue(payload.toDeviceId, {
        id: msgId,
        ts,
        from: payload.from ?? "",
        envelope: payload.envelope,
      });
      if (!accepted) {
        sendJson(res, 429, { ok: false, error: "inbox-capacity-exceeded" });
        return;
      }
      sendJson(res, 200, { ok: true, msgId });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not-found" });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const assignedPort =
    typeof address === "object" && address && "port" in address ? address.port : port;
  const baseUrl = `http://${host}:${assignedPort}`;

  return {
    baseUrl,
    port: assignedPort,
    authToken,
    setTorSocksProxy,
    setalternateRouteSocksProxy,
    setTorOnionHost,
    setalternateRouteAddress,
    prewarmTorRoute,
    close: async () => {
      clearInterval(cleanupTimer);
      clearSocksAgentPool(torForwarding.proxyUrl);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
