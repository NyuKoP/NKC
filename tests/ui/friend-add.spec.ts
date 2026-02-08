import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  disableAnimations,
  enableFriendFlowCapture,
  ensureOnboarded,
  filterFriendFlowLogsByAction,
  readFriendFlowLogs,
  resetFriendFlowLogs,
} from "./helpers";

type OnionInboxItem = {
  id: string;
  ts: number;
  from: string;
  envelope: string;
};

type OnionTestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const applyCors = (res: http.ServerResponse) => {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
};

const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const startOnionTestServer = async (): Promise<OnionTestServer> => {
  const inbox = new Map<string, OnionInboxItem[]>();

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      applyCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/onion/health") {
      sendJson(res, 200, { ok: true, network: "none", details: "local-only mode" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/inbox") {
      const deviceId = url.searchParams.get("deviceId") ?? "";
      if (!deviceId) {
        sendJson(res, 400, { ok: false, items: [], nextAfter: null, error: "missing-device" });
        return;
      }
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw ? Number.parseInt(afterRaw, 10) : -1;
      const start = Number.isFinite(after) ? after + 1 : 0;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : 50;
      const list = inbox.get(deviceId) ?? [];
      const slice = list.slice(start, start + limit);
      const nextAfter = slice.length > 0 ? String(start + slice.length - 1) : afterRaw ?? null;
      sendJson(res, 200, { ok: true, items: slice, nextAfter });
      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/send") {
      let parsed: {
        toDeviceId?: string;
        fromDeviceId?: string;
        envelope?: string;
      };
      try {
        parsed = JSON.parse(await readBody(req)) as {
          toDeviceId?: string;
          fromDeviceId?: string;
          envelope?: string;
        };
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });
        return;
      }

      if (!parsed.toDeviceId || !parsed.envelope) {
        sendJson(res, 400, { ok: false, error: "missing-fields" });
        return;
      }

      const id = randomUUID();
      const ts = Date.now();
      const items = inbox.get(parsed.toDeviceId) ?? [];
      items.push({
        id,
        ts,
        from: parsed.fromDeviceId ?? "",
        envelope: parsed.envelope,
      });
      inbox.set(parsed.toDeviceId, items);
      sendJson(res, 200, { ok: true, msgId: id, forwarded: false });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not-found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start onion test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const encodeBase64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const hash32Bytes = (bytes: Uint8Array) => {
  const seeds = [
    0x811c9dc5, 0x01000193, 0x1234567, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1,
  ];
  const out = new Uint8Array(seeds.length * 4);
  seeds.forEach((seed, idx) => {
    let hash = seed >>> 0;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    const offset = idx * 4;
    out[offset] = (hash >>> 24) & 0xff;
    out[offset + 1] = (hash >>> 16) & 0xff;
    out[offset + 2] = (hash >>> 8) & 0xff;
    out[offset + 3] = hash & 0xff;
  });
  return out;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const next: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      next[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return next;
  }
  return value;
};

const makeFriendCode = () => {
  const identityPub = randomBytes(32);
  const dhPub = randomBytes(32);
  const deviceId = randomUUID();
  const payload = {
    v: 1 as const,
    identityPub: encodeBase64Url(identityPub),
    dhPub: encodeBase64Url(dhPub),
    deviceId,
  };
  const payloadBytes = Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
  const checksum = hash32Bytes(payloadBytes).slice(0, 4);
  const combined = Buffer.concat([payloadBytes, Buffer.from(checksum)]);
  const friendCode = `NKC1-${encodeBase64Url(combined)}`;
  const friendId = encodeBase64Url(hash32Bytes(identityPub)).slice(0, 16);
  return { friendCode, expectedDisplayName: `Friend ${friendId.slice(0, 6)}` };
};

const seedNetworkConfig = async (
  page: import("@playwright/test").Page,
  onionControllerUrl: string
) => {
  await page.addInitScript((url) => {
    localStorage.setItem(
      "netConfig.v1",
      JSON.stringify({
        mode: "onionRouter",
        onionProxyEnabled: true,
        onionProxyUrl: "http://127.0.0.1:8080",
        webrtcRelayOnly: true,
        disableLinkPreview: true,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: true,
        onionSelectedNetwork: "tor",
        tor: { installed: false, status: "idle" },
        lokinet: { installed: false, status: "idle" },
      })
    );
    localStorage.setItem("onion_controller_url_v1", url);
  }, onionControllerUrl);
};

test.describe("Friend add E2E", () => {
  let onionServer: OnionTestServer;

  test.beforeAll(async () => {
    onionServer = await startOnionTestServer();
  });

  test.afterAll(async () => {
    await onionServer.close();
  });

  test("adds friend and shows it in friend list", async ({ page }) => {
    const { friendCode, expectedDisplayName } = makeFriendCode();
    await seedNetworkConfig(page, onionServer.baseUrl);
    await enableFriendFlowCapture(page);

    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
    await resetFriendFlowLogs(page);

    await page.getByTestId("list-mode-friends").click();
    await page.getByRole("button", { name: /친구 추가|Add friend/i }).first().click();

    const dialog = page.getByRole("dialog");
    const friendCodeInput = dialog
      .locator("label", { hasText: /친구 코드|Friend code/i })
      .locator("input");
    await friendCodeInput.fill(friendCode);

    await dialog.getByRole("button", { name: /^친구 추가$|^Add friend$/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByTestId("list-mode-friends").click();
    await expect(page.getByTestId("sidebar").getByText(expectedDisplayName, { exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const logs = await readFriendFlowLogs(page);
        const addLogs = filterFriendFlowLogsByAction(logs, "add");
        return addLogs.length;
      })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => {
        const logs = await readFriendFlowLogs(page);
        const addLogs = filterFriendFlowLogsByAction(logs, "add");
        const events = addLogs
          .map((record) => record.event)
          .filter((event): event is { result?: unknown; stage?: unknown } => {
            return Boolean(event && typeof event === "object");
          });
        const startIndex = events.findIndex(
          (event) => event.result === "progress" && event.stage === "progress:start"
        );
        const doneIndex = events.findIndex(
          (event) =>
            event.result === "added" &&
            typeof event.stage === "string" &&
            event.stage.startsWith("result:added-")
        );
        return startIndex >= 0 && doneIndex > startIndex;
      })
      .toBe(true);
  });
});
