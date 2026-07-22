import { describe, expect, it, vi } from "vitest";
import { startOnionController } from "../onionController";
import type { SocksTransport } from "../socksHttpClient";

const onion = `${"a".repeat(56)}.onion`;

describe("onion controller Tor prewarm", () => {
  it("coalesces concurrent probes and reuses a recent successful route", async () => {
    const fetch = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    const transport: SocksTransport = {
      fetch,
      forward: vi.fn(),
      clearProxy: vi.fn(async () => undefined),
    };
    const controller = await startOnionController({ port: 0, socksTransport: transport });
    try {
      await controller.setTorSocksProxy("socks5h://127.0.0.1:19050");
      const results = await Promise.all([
        controller.prewarmTorRoute(onion),
        controller.prewarmTorRoute(onion),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await controller.prewarmTorRoute(onion)).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await controller.close();
    }
  });

  it("invalidates the route cache when the proxy changes", async () => {
    const fetch = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    const transport: SocksTransport = {
      fetch,
      forward: vi.fn(),
      clearProxy: vi.fn(async () => undefined),
    };
    const controller = await startOnionController({ port: 0, socksTransport: transport });
    try {
      await controller.setTorSocksProxy("socks5h://127.0.0.1:19050");
      await controller.prewarmTorRoute(onion);
      await controller.setTorSocksProxy("socks5h://127.0.0.1:19051");
      await controller.prewarmTorRoute(onion);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(transport.clearProxy).toHaveBeenCalledWith("socks5h://127.0.0.1:19050");
    } finally {
      await controller.close();
    }
  });

  it("starts bounded Tor lanes and proceeds with the first successful lane", async () => {
    const fetch = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    const transport: SocksTransport = {
      fetch,
      forward: vi.fn(),
      clearProxy: vi.fn(async () => undefined),
    };
    const controller = await startOnionController({ port: 0, socksTransport: transport });
    try {
      await controller.setTorSocksProxies([
        "socks5h://127.0.0.1:19050",
        "socks5h://127.0.0.1:19051",
      ]);
      expect((await controller.prewarmTorRoute(onion)).ok).toBe(true);
      expect(fetch.mock.calls.map((call) =>
        (call as unknown as [string, { socksProxyUrl: string }])[1].socksProxyUrl
      )).toEqual([
        "socks5h://127.0.0.1:19050",
        "socks5h://127.0.0.1:19051",
      ]);
    } finally {
      await controller.close();
    }
  });

  it("does not wait for a stalled lane after another lane succeeds", async () => {
    let stalledLaneStarted = false;
    const fetch = vi.fn((_url: string, options: { socksProxyUrl?: string }) => {
      if (options.socksProxyUrl?.endsWith(":19050")) {
        stalledLaneStarted = true;
        return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
          () => undefined
        );
      }
      return Promise.resolve({ status: 200, headers: {}, body: Buffer.alloc(0) });
    });
    const transport: SocksTransport = {
      fetch,
      forward: vi.fn(),
      clearProxy: vi.fn(async () => undefined),
    };
    const controller = await startOnionController({ port: 0, socksTransport: transport });
    try {
      await controller.setTorSocksProxies([
        "socks5h://127.0.0.1:19050",
        "socks5h://127.0.0.1:19051",
      ]);
      const result = await controller.prewarmTorRoute(onion);
      expect(stalledLaneStarted).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      await controller.close();
    }
  });
});
