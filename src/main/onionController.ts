import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { TorStatus } from "./torManager";
import type { LokinetStatus } from "./lokinetManager";
import { socksFetch } from "./socksHttpClient";
import { buildRouteCandidates, type RouteMode } from "./routePolicy";

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

export const startOnionController = async (options?: {
  port?: number;
  getTorStatus?: () => TorStatus;
  getLokinetStatus?: () => LokinetStatus;
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
      let payload: {
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
      try {
        payload = JSON.parse(parsed.body) as {
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
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });
        return;
      }
      if (!payload.envelope) {
        sendJson(res, 400, { ok: false, error: "missing-fields" });
        return;
      }
      const msgId = randomUUID();
      const ts = Date.now();
      const toOnion = payload.toOnion ?? payload.route?.torOnion ?? (payload.to?.includes(".onion") ? payload.to : undefined);
      const toDeviceId = payload.toDeviceId ?? payload.to;
      const fromDeviceId = payload.fromDeviceId ?? payload.from ?? "";
      const routeMode = payload.route?.mode ?? "manual";
      const lokinetAddress = payload.route?.lokinet;

      if (!toDeviceId) {
        sendJson(res, 400, { ok: false, error: "missing-to-device" });
        return;
      }
      const hasRouteTargets = Boolean(toOnion || lokinetAddress);
      if (payload.route || hasRouteTargets) {
        const candidates = buildRouteCandidates(routeMode, {
          torOnion: toOnion,
          lokinet: lokinetAddress,
        });
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          const isLast = index === candidates.length - 1;
          const proxyUrl =
            candidate.kind === "tor" ? torForwarding.proxyUrl : lokinetForwarding.proxyUrl;
          if (!proxyUrl) {
            if (routeMode === "auto") continue;
            sendJson(res, 400, { ok: false, error: "forward_failed:no_proxy" });
            return;
          }
          try {
            const response = await socksFetch(`${candidate.target}/onion/ingest`, {
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
              timeoutMs: 10000,
              socksProxyUrl: proxyUrl,
              retry: { attempts: 2, delayMs: 200 },
            });
            if (response.status >= 200 && response.status < 300) {
              sendJson(res, 200, { ok: true, msgId, forwarded: true, route: candidate.kind });
              return;
            }
            if (!isLast && routeMode === "auto") {
              continue;
            }
            sendJson(res, 502, { ok: false, error: `forward_failed:${response.status}` });
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isLast && routeMode === "auto") {
              continue;
            }
            sendJson(res, 502, { ok: false, error: `forward_failed:${message}` });
            return;
          }
        }
        sendJson(res, 400, { ok: false, error: "forward_failed:no_route" });
        return;
      }
      enqueue(toDeviceId, {
        id: msgId,
        ts,
        from: fromDeviceId,
        envelope: payload.envelope,
        ttlMs: payload.ttlMs,
      });
      sendJson(res, 200, { ok: true, msgId, forwarded: false });
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
