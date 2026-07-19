import { describe, expect, it, vi } from "vitest";
import { createNativeSocksTransport } from "../socksHttpClient";

describe("native SOCKS transport adapter", () => {
  it("encodes request bytes and decodes the Go worker response", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      bodyBase64: Buffer.from("OK").toString("base64"),
      attempts: 1,
    }));
    const transport = createNativeSocksTransport({ request } as never);

    const response = await transport.fetch("http://example.onion/onion/ingest", {
      method: "POST",
      body: Buffer.from("payload"),
      socksProxyUrl: "socks5h://127.0.0.1:9050",
    });

    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("OK"),
    });
    expect(request).toHaveBeenCalledWith(
      "transport.fetch",
      expect.objectContaining({
        bodyBase64: Buffer.from("payload").toString("base64"),
        socksProxyUrl: "socks5h://127.0.0.1:9050",
      }),
      50_000
    );
  });

  it("clears a pooled proxy in the Go worker", async () => {
    const request = vi.fn(async () => ({ cleared: true }));
    const transport = createNativeSocksTransport({ request } as never);
    await transport.clearProxy(" socks5h://127.0.0.1:9050 ");
    expect(request).toHaveBeenCalledWith(
      "transport.clearProxy",
      { proxyUrl: "socks5h://127.0.0.1:9050" },
      5_000
    );
  });

  it("delegates route failover and offline queueing to the Go worker", async () => {
    const request = vi.fn(async () => ({
      status: 202,
      body: { ok: true, queued: true },
      traces: [{ event: "onionController:offlineQueue:pending" }],
    }));
    const transport = createNativeSocksTransport({ request } as never);
    const payload = { toDeviceId: "peer-1", envelope: "ciphertext" };

    await expect(
      transport.forward(payload, {
        torProxyUrl: "socks5h://127.0.0.1:9050",
        queueOnFailure: true,
      })
    ).resolves.toMatchObject({ status: 202 });
    expect(request).toHaveBeenCalledWith(
      "transport.forward",
      {
        payload,
        torProxyUrl: "socks5h://127.0.0.1:9050",
        alternateRouteProxyUrl: "",
        queueOnFailure: true,
      },
      95_000
    );
  });
});
