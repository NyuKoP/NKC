import { describe, expect, it, vi } from "vitest";
import { createOnionRouterTransport } from "../../../adapters/transports/onionRouterTransport";

describe("onionRouter transport gating", () => {
  const root = globalThis as typeof globalThis & { nkc?: Record<string, unknown> };
  const prevNkc = root.nkc;

  const encodeJsonBody = (payload: unknown) =>
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  it("fails with FATAL_MISCONFIG when destination is missing", async () => {
    const torRuntime = {
      start: vi.fn(async () => {}),
      awaitReady: vi.fn(async () => {}),
      markDegraded: vi.fn(),
    };
    const transport = createOnionRouterTransport({
      httpClient: {
        request: vi.fn(async () => new Response()),
        healthCheck: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      config: {
        mode: "onionRouter",
        onionProxyEnabled: true,
        onionProxyUrl: "socks5://127.0.0.1:9050",
        webrtcRelayOnly: true,
        disableLinkPreview: true,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: true,
        onionSelectedNetwork: "tor",
        tor: { installed: true, status: "ready", version: "1.0.0" },
        lokinet: { installed: false, status: "idle" },
        lastUpdateCheckAtMs: undefined,
      },
      torRuntime,
    });

    await expect(
      transport.send({
        id: "m-missing-to",
        payload: "ciphertext",
      } as unknown as Parameters<typeof transport.send>[0])
    ).rejects.toMatchObject({
      code: "FATAL_MISCONFIG",
    });
    expect(torRuntime.awaitReady).not.toHaveBeenCalled();
  });

  it("returns TOR_NOT_READY quickly when Tor runtime is not READY", async () => {
    const torRuntime = {
      start: vi.fn(async () => {}),
      awaitReady: vi.fn(async () => {
        throw Object.assign(new Error("not ready"), { code: "TOR_NOT_READY" });
      }),
      markDegraded: vi.fn(),
    };
    const transport = createOnionRouterTransport({
      httpClient: {
        request: vi.fn(async () => new Response()),
        healthCheck: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      config: {
        mode: "onionRouter",
        onionProxyEnabled: true,
        onionProxyUrl: "socks5://127.0.0.1:9050",
        webrtcRelayOnly: true,
        disableLinkPreview: true,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: true,
        onionSelectedNetwork: "tor",
        tor: { installed: true, status: "ready", version: "1.0.0" },
        lokinet: { installed: false, status: "idle" },
        lastUpdateCheckAtMs: undefined,
      },
      torRuntime,
    });

    await expect(
      transport.send({
        id: "m1",
        payload: "ciphertext",
        toDeviceId: "peer-device",
      } as unknown as Parameters<typeof transport.send>[0])
    ).rejects.toMatchObject({
      code: "TOR_NOT_READY",
    });
    expect(torRuntime.awaitReady).toHaveBeenCalledTimes(1);
  });

  it("resyncs Tor forward proxy and recovers from proxy_unreachable once", async () => {
    let sendCallCount = 0;
    const setOnionForwardProxy = vi.fn(async () => ({ ok: true }));
    root.nkc = {
      getOnionControllerUrl: async () => "http://127.0.0.1:3210",
      getTorStatus: async () => ({ state: "running", socksProxyUrl: "socks5://127.0.0.1:9050" }),
      setOnionForwardProxy,
      onionControllerFetch: async (req: { url: string }) => {
        const path = new URL(req.url).pathname;
        if (path === "/onion/health") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            bodyBase64: encodeJsonBody({ ok: true, network: "tor", details: "route proxies enabled" }),
          };
        }
        if (path === "/onion/send") {
          sendCallCount += 1;
          if (sendCallCount === 1) {
            return {
              status: 502,
              headers: { "content-type": "application/json" },
              bodyBase64: encodeJsonBody({ ok: false, error: "forward_failed:proxy_unreachable" }),
            };
          }
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            bodyBase64: encodeJsonBody({ ok: true, msgId: "m-retry-ok" }),
          };
        }
        if (path === "/onion/inbox") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            bodyBase64: encodeJsonBody({ ok: true, items: [], nextAfter: null }),
          };
        }
        return {
          status: 404,
          headers: { "content-type": "application/json" },
          bodyBase64: encodeJsonBody({ ok: false, error: "not-found" }),
        };
      },
    };

    const torRuntime = {
      start: vi.fn(async () => {}),
      awaitReady: vi.fn(async () => {}),
      markDegraded: vi.fn(),
    };
    const transport = createOnionRouterTransport({
      httpClient: {
        request: vi.fn(async () => new Response()),
        healthCheck: vi.fn(async () => ({ ok: true, message: "ok" })),
      },
      config: {
        mode: "onionRouter",
        onionProxyEnabled: true,
        onionProxyUrl: "socks5://127.0.0.1:9050",
        webrtcRelayOnly: true,
        disableLinkPreview: true,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: true,
        onionSelectedNetwork: "tor",
        tor: { installed: true, status: "ready", version: "1.0.0" },
        lokinet: { installed: false, status: "idle" },
        lastUpdateCheckAtMs: undefined,
      },
      torRuntime,
    });

    try {
      await transport.start();
      await expect(
        transport.send({
          id: "m-proxy-retry",
          payload: "ciphertext",
          toDeviceId: "peer-device",
          route: { torOnion: "peeraddress.onion" },
        } as unknown as Parameters<typeof transport.send>[0])
      ).resolves.toBeUndefined();
      expect(setOnionForwardProxy).toHaveBeenCalled();
      expect(sendCallCount).toBe(2);
      expect(torRuntime.markDegraded).not.toHaveBeenCalled();
    } finally {
      await transport.stop();
      root.nkc = prevNkc;
    }
  });
});
