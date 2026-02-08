import { describe, expect, it, vi } from "vitest";
import { createOnionRouterTransport } from "../../../adapters/transports/onionRouterTransport";

describe("onionRouter transport gating", () => {
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
});
