import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerHint } from "../transport";

type AdapterState = "idle" | "connecting" | "connected" | "failed" | "degraded";

type AdapterMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onMessage: (cb: (packet: unknown) => void) => void;
  onState: (cb: (state: AdapterState) => void) => void;
  emitState: (state: AdapterState) => void;
};

const shared = vi.hoisted(() => ({
  adapter: null as AdapterMock | null,
}));

vi.mock("../../adapters/transports/directP2PTransport", () => ({
  createDirectP2PTransport: () => {
    if (!shared.adapter) {
      throw new Error("adapter mock not initialized");
    }
    return shared.adapter;
  },
}));

const createAdapterMock = (): AdapterMock => {
  let state: AdapterState = "idle";
  const stateListeners = new Set<(next: AdapterState) => void>();
  return {
    start: vi.fn(async () => {
      state = "connecting";
      stateListeners.forEach((listener) => listener(state));
    }),
    stop: vi.fn(async () => {
      state = "idle";
      stateListeners.forEach((listener) => listener(state));
    }),
    send: vi.fn(async () => undefined),
    onMessage: () => undefined,
    onState: (cb) => {
      stateListeners.add(cb);
      cb(state);
    },
    emitState: (next) => {
      state = next;
      stateListeners.forEach((listener) => listener(next));
    },
  };
};

describe("directTransport.connect", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only after adapter becomes connected", async () => {
    shared.adapter = createAdapterMock();
    const { createDirectTransport } = await import("../directTransport");
    const transport = createDirectTransport();
    let settled = false;
    const connectPromise = transport.connect().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(shared.adapter.start).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    shared.adapter.emitState("connected");
    await connectPromise;
    expect(transport.getStatus().state).toBe("connected");
  });

  it("uses longer timeout for device peer hints", async () => {
    vi.useFakeTimers();
    shared.adapter = createAdapterMock();
    const { createDirectTransport } = await import("../directTransport");
    const transport = createDirectTransport();
    const peerHint: PeerHint = { kind: "device" };
    const connectPromise = transport.connect(peerHint);
    void connectPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(8_500);
    expect(transport.getStatus().state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(11_600);
    await expect(connectPromise).rejects.toThrow("timeout");
  });

  it("fails when adapter never reaches connected", async () => {
    vi.useFakeTimers();
    shared.adapter = createAdapterMock();
    const { createDirectTransport } = await import("../directTransport");
    const transport = createDirectTransport();
    const connectPromise = transport.connect();
    void connectPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(8_100);
    await expect(connectPromise).rejects.toThrow("timeout");
    expect(transport.getStatus().state).toBe("failed");
  });
});
