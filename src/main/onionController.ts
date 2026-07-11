import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { TorStatus } from "./torManager";
import type { LokinetStatus } from "./lokinetManager";
import { socksFetch } from "./socksHttpClient";
import { selectRoute, type RouteMode } from "./routePolicy";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { appendTestLogRecord } from "./testLogStore";

type InboxItem = {
  id: string;
  ts: number;
  from: string;
  envelope: string;
  expiresAt: number;
};

type ForwardingState = {
  proxyUrl: string | null;
  ready: boolean;
};

export type OnionControllerHandle = {
  baseUrl: string;
  port: number;
  setTorSocksProxy: (proxyUrl: string | null) => Promise<void>;
  setLokinetSocksProxy: (proxyUrl: string | null) => Promise<void>;
  setTorOnionHost: (host: string | null) => void;
  setLokinetAddress: (address: string | null) => void;
  close: () => Promise<void>;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const FORWARD_TIMEOUT_MS = 45_000;
const FORWARD_RETRY_ATTEMPTS = 1;
const FORWARD_RETRY_DELAY_MS = 350;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
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
    lokinet?: string;
  };
};

type OnionSendDeps = {
  socksFetch: typeof socksFetch;
  selectRoute: typeof selectRoute;
  now: () => number;
  uuid: () => string;
  torProxyUrl: string | null;
  lokinetProxyUrl: string | null;
  storeLocal: (deviceId: string, item: Omit<InboxItem, "expiresAt"> & { ttlMs?: number }) => void;
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
  if (!payload.envelope) {
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
  const lokinetAddress = payload.route?.lokinet;

  if (!toDeviceId) {
    return { status: 400, body: { ok: false, error: "missing-to-device" } };
  }
  const hasRouteTargets = Boolean(toOnion || lokinetAddress);
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
        lokinet: lokinetAddress,
      },
      {
        tor: Boolean(deps.torProxyUrl),
        lokinet: Boolean(deps.lokinetProxyUrl),
      }
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const isLast = index === candidates.length - 1;
      const proxyUrl = candidate.kind === "tor" ? deps.torProxyUrl : deps.lokinetProxyUrl;
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
    if (!offlineQueueReason && toOnion && deps.enqueueOfflineMessage && routeMode !== "preferLokinet") {
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

  deps.storeLocal(toDeviceId, {
    id: msgId,
    ts,
    from: fromDeviceId,
    envelope: payload.envelope,
    ttlMs: payload.ttlMs,
  });
  return { status: 200, body: { ok: true, msgId, forwarded: false } };
};

export const startOnionController = async (options?: {
  port?: number;
  getTorStatus?: () => TorStatus;
  getLokinetStatus?: () => LokinetStatus;
  userDataPath?: string;
  enqueueOfflineMessage?: OnionSendDeps["enqueueOfflineMessage"];
}): Promise<OnionControllerHandle> => {
  const host = "127.0.0.1";
  const port = options?.port ?? 3210;
  const inbox = new Map<string, InboxItem[]>();
  const torForwarding: ForwardingState = {
    proxyUrl: null,
    ready: false,
  };
  const lokinetForwarding: ForwardingState = {
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
  let myLokinetAddress: string | null = null;
  const setTorSocksProxy = async (proxyUrl: string | null) => {
    const trimmed = proxyUrl?.trim() ?? "";
    if (!trimmed) {
      torForwarding.proxyUrl = null;
      torForwarding.ready = false;
      return;
    }
    torForwarding.proxyUrl = trimmed;
    torForwarding.ready = true;
  };

  const setLokinetSocksProxy = async (proxyUrl: string | null) => {
    const trimmed = proxyUrl?.trim() ?? "";
    if (!trimmed) {
      lokinetForwarding.proxyUrl = null;
      lokinetForwarding.ready = false;
      return;
    }
    lokinetForwarding.proxyUrl = trimmed;
    lokinetForwarding.ready = true;
  };

  const setTorOnionHost = (hostValue: string | null) => {
    const trimmed = hostValue?.trim() ?? "";
    myTorOnionHost = trimmed ? trimmed : null;
  };

  const setLokinetAddress = (addressValue: string | null) => {
    const trimmed = addressValue?.trim() ?? "";
    myLokinetAddress = trimmed ? trimmed : null;
  };

  const enqueue = (deviceId: string, item: Omit<InboxItem, "expiresAt"> & { ttlMs?: number }) => {
    const ttlMs = item.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = item.ts + ttlMs;
    const entry: InboxItem = { ...item, expiresAt };
    const list = inbox.get(deviceId) ?? [];
    list.push(entry);
    inbox.set(deviceId, list);
  };

  const cleanup = () => {
    const now = Date.now();
    for (const [deviceId, items] of inbox.entries()) {
      const remaining = items.filter((item) => item.expiresAt > now);
      if (remaining.length) {
        inbox.set(deviceId, remaining);
      } else {
        inbox.delete(deviceId);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/onion/health") {
      const torStatus = options?.getTorStatus ? options.getTorStatus() : null;
      const lokinetStatus = options?.getLokinetStatus ? options.getLokinetStatus() : null;
      const torActive = Boolean(
        torStatus &&
          torStatus.state === "running" &&
          torForwarding.ready &&
          torForwarding.proxyUrl
      );
      const lokinetActive = Boolean(
        lokinetStatus &&
          lokinetStatus.state === "running" &&
          lokinetForwarding.ready &&
          lokinetForwarding.proxyUrl
      );
      const details = torActive || lokinetActive ? "route proxies enabled" : "local-only mode";
      const network = torActive ? "tor" : lokinetActive ? "lokinet" : "none";
      sendJson(res, 200, {
        ok: true,
        network,
        details,
        tor: {
          active: torActive,
          socksProxy: torForwarding.proxyUrl ?? null,
          address: myTorOnionHost ?? undefined,
          details: torStatus?.state,
        },
        lokinet: {
          active: lokinetActive,
          proxyUrl: lokinetForwarding.proxyUrl ?? null,
          address: myLokinetAddress ?? undefined,
          details: lokinetStatus?.state,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/address") {
      sendJson(res, 200, {
        ok: true,
        torOnion: myTorOnionHost ?? undefined,
        lokinet: myLokinetAddress ?? undefined,
        details:
          myTorOnionHost || myLokinetAddress
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
        lokinetProxyUrl: lokinetForwarding.proxyUrl,
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
      const startIndex = Number.isFinite(afterIndex) ? afterIndex + 1 : 0;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : 50;
      const list = inbox.get(deviceId) ?? [];
      const slice = list.slice(startIndex, startIndex + limit);
      const items = slice.map((item) => ({
        id: item.id,
        ts: item.ts,
        from: item.from,
        envelope: item.envelope,
      }));
      const nextAfter =
        items.length > 0 ? String(startIndex + items.length - 1) : afterRaw ?? null;
      sendJson(res, 200, { ok: true, items, nextAfter });
      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/ingest") {
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
      if (!payload.toDeviceId || !payload.envelope) {
        sendJson(res, 400, { ok: false, error: "missing-fields" });
        return;
      }
      const msgId = payload.id ?? randomUUID();
      const ts = payload.ts ?? Date.now();
      enqueue(payload.toDeviceId, {
        id: msgId,
        ts,
        from: payload.from ?? "",
        envelope: payload.envelope,
      });
      sendJson(res, 200, { ok: true, msgId });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not-found" });
  });

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
    setTorSocksProxy,
    setLokinetSocksProxy,
    setTorOnionHost,
    setLokinetAddress,
    close: async () => {
      clearInterval(cleanupTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
