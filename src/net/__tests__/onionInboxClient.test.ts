import { afterEach, describe, expect, it, vi } from "vitest";
import { OnionInboxClient } from "../onionInboxClient";

const encodeJsonBody = (value: unknown) => {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

describe("OnionInboxClient.send", () => {
  afterEach(() => {
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = undefined;
  });

  it("surfaces forward_failed code from non-2xx onion/send response body", async () => {
    const onionControllerFetch = vi.fn().mockResolvedValue({
      status: 502,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeJsonBody({ ok: false, error: "forward_failed:timeout" }),
      error: undefined,
    });
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = { onionControllerFetch };

    const client = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });

    const result = await client.send("target-device", "envelope");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("forward_failed:timeout");
  });

  it("includes HTTP status in fallback error when body/error fields are missing", async () => {
    const onionControllerFetch = vi.fn().mockResolvedValue({
      status: 502,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeJsonBody({ ok: false }),
      error: undefined,
    });
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = { onionControllerFetch };

    const client = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });

    const result = await client.send("target-device", "envelope");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Send failed (status 502)");
  });

  it("uses extended timeout for onion/send requests", async () => {
    const onionControllerFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeJsonBody({ ok: true, msgId: "m-1" }),
      error: undefined,
    });
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = { onionControllerFetch };

    const client = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });

    const result = await client.send("target-device", "envelope");

    expect(result.ok).toBe(true);
    expect(onionControllerFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30_000,
      })
    );
  });

  it("coalesces concurrent /onion/inbox requests into one fetch", async () => {
    let resolveFetch!: (value: unknown) => void;
    const onionControllerFetch = vi.fn().mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFetch = resolve;
        })
    );
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = { onionControllerFetch };

    const client = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });

    const pending = Array.from({ length: 10 }, () => client.poll(null, 50));
    await Promise.resolve();
    expect(onionControllerFetch).toHaveBeenCalledTimes(1);

    resolveFetch({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeJsonBody({
        ok: true,
        items: [],
        nextAfter: null,
      }),
      error: undefined,
    });
    const results = await Promise.all(pending);
    expect(results).toHaveLength(10);
    results.forEach((result) => {
      expect(result.ok).toBe(true);
      expect(result.items).toEqual([]);
    });
  });

  it("coalesces concurrent /onion/inbox requests across client instances", async () => {
    let resolveFetch!: (value: unknown) => void;
    const onionControllerFetch = vi.fn().mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFetch = resolve;
        })
    );
    (
      globalThis as {
        nkc?: {
          onionControllerFetch?: (req: unknown) => Promise<unknown>;
        };
      }
    ).nkc = { onionControllerFetch };

    const clientA = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });
    const clientB = new OnionInboxClient({
      baseUrl: "http://127.0.0.1:3210",
      deviceId: "sender-device",
    });

    const pendingA = clientA.poll(null, 50);
    const pendingB = clientB.poll(null, 50);
    await Promise.resolve();
    expect(onionControllerFetch).toHaveBeenCalledTimes(1);

    resolveFetch({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: encodeJsonBody({
        ok: true,
        items: [],
        nextAfter: null,
      }),
      error: undefined,
    });

    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
  });
});
