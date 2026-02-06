import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalOnionRouteManager } from "../routeManager";
import type { InternalOnionControlPlaneMessage, InternalOnionRouteState } from "../types";

describe("InternalOnionRouteManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const createManager = (options: {
    relayPeerIds: string[];
    onEmit?: (manager: InternalOnionRouteManager, message: InternalOnionControlPlaneMessage) => void;
    states?: InternalOnionRouteState[];
    keepaliveMissLimit?: number;
    keepaliveIntervalMs?: number;
    helloAckTimeoutMs?: number;
    rebuildBackoffMs?: number[];
  }) => {
    const states = options.states ?? [];
    const manager = new InternalOnionRouteManager({
      getRelayPeerIds: () => options.relayPeerIds,
      getLocalPeerId: () => "local-peer",
      onStateChange: (state) => {
        states.push(state);
      },
      emitControlPlane: (message) => {
        options.onEmit?.(manager, message);
      },
      keepaliveMissLimit: options.keepaliveMissLimit ?? 2,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 1_000,
      helloAckTimeoutMs: options.helloAckTimeoutMs ?? 1_000,
      rebuildBackoffMs: options.rebuildBackoffMs ?? [1_000, 5_000],
    });
    return { manager, states };
  };

  it("transitions building -> ready on sequential HELLO/ACK", async () => {
    const { manager, states } = createManager({
      relayPeerIds: ["peer-1", "peer-2", "peer-3"],
      onEmit: (instance, message) => {
        if (message.type !== "HOP_HELLO") return;
        instance.handleHelloAck({
          type: "HOP_ACK",
          circuitId: message.circuitId,
          hopIndex: message.hopIndex,
          ts: Date.now(),
          relayPeerId: `peer-${message.hopIndex}`,
          ok: true,
        });
      },
    });

    const built = await manager.start(3);
    expect(built).toBe(true);
    expect(states.some((state) => state.status === "building")).toBe(true);
    expect(manager.getState().status).toBe("ready");
    expect(manager.getState().establishedHops).toBe(3);
    manager.stop();
  });

  it("increments establishedHops only after ACK", async () => {
    const { manager } = createManager({
      relayPeerIds: ["peer-1", "peer-2", "peer-3"],
      helloAckTimeoutMs: 1_000,
      onEmit: (instance, message) => {
        if (message.type !== "HOP_HELLO") return;
        if (message.hopIndex !== 1) return;
        instance.handleHelloAck({
          type: "HOP_ACK",
          circuitId: message.circuitId,
          hopIndex: 1,
          ts: Date.now(),
          relayPeerId: "peer-1",
          ok: true,
        });
      },
    });

    const buildPromise = manager.start(3);
    await vi.advanceTimersByTimeAsync(1_500);
    const built = await buildPromise;
    expect(built).toBe(false);
    expect(manager.getState().status).toBe("degraded");
    expect(manager.getState().establishedHops).toBe(1);
    manager.stop();
  });

  it("marks route ready when at least one relay is available", async () => {
    const { manager } = createManager({
      relayPeerIds: ["peer-1"],
      onEmit: (instance, message) => {
        if (message.type !== "HOP_HELLO") return;
        instance.handleHelloAck({
          type: "HOP_ACK",
          circuitId: message.circuitId,
          hopIndex: message.hopIndex,
          ts: Date.now(),
          relayPeerId: "peer-1",
          ok: true,
        });
      },
    });

    const built = await manager.start(3);
    expect(built).toBe(true);
    expect(manager.getState().status).toBe("ready");
    expect(manager.getState().establishedHops).toBe(1);
    expect(manager.getState().hops[0]?.status).toBe("ok");
    expect(manager.getState().hops[1]?.status).toBe("pending");
    manager.stop();
  });

  it("transitions ready -> degraded when keepalive misses exceed threshold", async () => {
    const { manager } = createManager({
      relayPeerIds: ["peer-1", "peer-2", "peer-3"],
      keepaliveIntervalMs: 1_000,
      keepaliveMissLimit: 2,
      onEmit: (instance, message) => {
        if (message.type !== "HOP_HELLO") return;
        instance.handleHelloAck({
          type: "HOP_ACK",
          circuitId: message.circuitId,
          hopIndex: message.hopIndex,
          ts: Date.now(),
          relayPeerId: `peer-${message.hopIndex}`,
          ok: true,
        });
      },
    });

    await manager.start(3);
    expect(manager.getState().status).toBe("ready");

    await vi.advanceTimersByTimeAsync(4_500);
    expect(manager.getState().status).toBe("degraded");
    manager.stop();
  });

  it("transitions degraded -> rebuilding -> ready after backoff rebuild", async () => {
    const states: InternalOnionRouteState[] = [];
    let phase: "initial" | "rebuild" = "initial";

    const { manager } = createManager({
      relayPeerIds: ["peer-1", "peer-2", "peer-3"],
      keepaliveIntervalMs: 1_000,
      keepaliveMissLimit: 2,
      rebuildBackoffMs: [1_000],
      states,
      onEmit: (instance, message) => {
        if (message.type === "HOP_HELLO") {
          instance.handleHelloAck({
            type: "HOP_ACK",
            circuitId: message.circuitId,
            hopIndex: message.hopIndex,
            ts: Date.now(),
            relayPeerId: `peer-${message.hopIndex}`,
            ok: true,
          });
          return;
        }
        if (message.type === "HOP_PING" && phase === "rebuild") {
          instance.handlePingPong({
            type: "HOP_PONG",
            circuitId: message.circuitId,
            hopIndex: message.hopIndex,
            ts: Date.now(),
          });
        }
      },
    });

    await manager.start(3);
    expect(manager.getState().status).toBe("ready");

    await vi.advanceTimersByTimeAsync(4_500);
    expect(manager.getState().status).toBe("degraded");

    phase = "rebuild";
    await vi.advanceTimersByTimeAsync(1_500);
    expect(manager.getState().status).toBe("ready");
    const statuses = states.map((state) => state.status);
    expect(statuses).toContain("degraded");
    expect(statuses).toContain("rebuilding");
    expect(statuses).toContain("ready");
    manager.stop();
  });
});
