import { beforeEach, describe, expect, it, vi } from "vitest";
import { RendezvousClient } from "../rendezvousSignaling";

const mocks = vi.hoisted(() => ({
  onionFetch: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../../adapters/transports/onionRouterTransport", () => ({
  onionFetch: mocks.onionFetch,
}));

vi.mock("../fetchWithTimeout", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

describe("RendezvousClient onion fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to direct fetch when onion fetch is unavailable", async () => {
    const onFallback = vi.fn();
    mocks.onionFetch.mockRejectedValueOnce(new Error("Onion fetch unavailable"));
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = new RendezvousClient({
      baseUrl: "https://rendezvous.example",
      useOnionProxy: true,
      onOnionProxyFallback: onFallback,
    });

    const result = await client.poll("NKC-SYNC1-AAAAAA", "device-a", 0);

    expect(result.items).toEqual([]);
    expect(result.nextAfterTs).toBe(0);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("Onion fetch unavailable"),
      })
    );
  });

  it("keeps onion fetch when available", async () => {
    mocks.onionFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const client = new RendezvousClient({
      baseUrl: "https://rendezvous.example",
      useOnionProxy: true,
    });

    await client.poll("NKC-SYNC1-BBBBBB", "device-b", 0);

    expect(mocks.onionFetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
