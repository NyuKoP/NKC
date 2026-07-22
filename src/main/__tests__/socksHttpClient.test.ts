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
        queueOnFailure: true,
      },
      95_000
    );
  });

  it("moves large routed payloads into the binary IPC body", async () => {
    const request = vi.fn();
    const requestBinary = vi.fn<(
      method: string,
      params: unknown,
      body: Buffer,
      timeoutMs: number
    ) => Promise<{ result: { status: number; body: Record<string, unknown> }; body: Buffer }>>()
      .mockResolvedValue({
      result: { status: 200, body: { ok: true, forwarded: true } },
      body: Buffer.alloc(0),
      });
    const transport = createNativeSocksTransport({ request, requestBinary } as never);
    const payload = { toDeviceId: "peer-1", envelope: "x".repeat(1024 * 1024) };

    await expect(transport.forward(payload, {
      torProxyUrl: "socks5h://127.0.0.1:9050",
      queueOnFailure: false,
    })).resolves.toMatchObject({ status: 200 });

    expect(request).not.toHaveBeenCalled();
    expect(requestBinary).toHaveBeenCalledTimes(1);
    const [method, params, body, timeoutMs] = requestBinary.mock.calls[0];
    expect(method).toBe("transport.forward.binary");
    expect(params).toEqual({
      torProxyUrl: "socks5h://127.0.0.1:9050",
      queueOnFailure: false,
    });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.byteLength).toBeGreaterThan(1024 * 1024);
    const decoded = JSON.parse(body.toString("utf8")) as typeof payload;
    expect(decoded.toDeviceId).toBe(payload.toDeviceId);
    expect(decoded.envelope.length).toBe(payload.envelope.length);
    expect(timeoutMs).toBe(95_000);
  });
});
