import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { net, session } from "electron";

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
  setForwardProxy: (proxyUrl: string | null) => Promise<void>;
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

const isUrlTarget = (value: string) =>
  value.startsWith("http://") || value.startsWith("https://");

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
}): Promise<OnionControllerHandle> => {
  const host = "127.0.0.1";
  const port = options?.port ?? 3210;
  const inbox = new Map<string, InboxItem[]>();
  const forwarding: ForwardingState = {
    proxyUrl: null,
    ready: false,
  };
  const forwardSession = session.fromPartition("persist:nkc-onion-forward");

  const setForwardProxy = async (proxyUrl: string | null) => {
    const trimmed = proxyUrl?.trim() ?? "";
    if (!trimmed) {
      forwarding.proxyUrl = null;
      forwarding.ready = false;
      await forwardSession.setProxy({ proxyRules: "" });
      return;
    }
    forwarding.proxyUrl = trimmed;
    try {
      await forwardSession.setProxy({ proxyRules: trimmed });
      forwarding.ready = true;
    } catch {
      forwarding.ready = false;
    }
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
      const details = forwarding.ready
        ? "forward proxy enabled"
        : forwarding.proxyUrl
          ? "local-only mode (proxy unavailable)"
          : "local-only mode";
      const network = forwarding.ready ? "tor" : "none";
      sendJson(res, 200, {
        ok: true,
        network,
        details,
        socksProxy: forwarding.proxyUrl,
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
      };
      try {
        payload = JSON.parse(parsed.body) as {
          to?: string;
          from?: string;
          envelope?: string;
          ttlMs?: number;
        };
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });
        return;
      }
      if (!payload.to || !payload.envelope) {
        sendJson(res, 400, { ok: false, error: "missing-fields" });
        return;
      }
      const msgId = randomUUID();
      const ts = Date.now();
      enqueue(payload.to, {
        id: msgId,
        ts,
        from: payload.from ?? "",
        envelope: payload.envelope,
        ttlMs: payload.ttlMs,
      });

      let forwarded = false;
      if (forwarding.ready && isUrlTarget(payload.to)) {
        try {
          if (typeof net.fetch === "function") {
            const response = await net.fetch(`${payload.to}/onion/ingest`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                toDeviceId: payload.to,
                from: payload.from,
                envelope: payload.envelope,
                ts,
                id: msgId,
              }),
              session: forwardSession,
            });
            forwarded = response.ok;
          } else {
            forwarded = await new Promise<boolean>((resolve) => {
              const request = net.request({
                method: "POST",
                url: `${payload.to}/onion/ingest`,
                session: forwardSession,
              });
              request.setHeader("Content-Type", "application/json");
              request.on("response", (response) => {
                resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300));
              });
              request.on("error", () => resolve(false));
              request.write(
                JSON.stringify({
                  toDeviceId: payload.to,
                  from: payload.from,
                  envelope: payload.envelope,
                  ts,
                  id: msgId,
                })
              );
              request.end();
            });
          }
        } catch {
          forwarded = false;
        }
      }

      sendJson(res, 200, { ok: true, msgId, forwarded });
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
    setForwardProxy,
    close: async () => {
      clearInterval(cleanupTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
