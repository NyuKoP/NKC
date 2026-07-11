import { afterEach, describe, expect, it } from "vitest";
import {
  createP2PConnectionStatePublisher,
  getP2PConnectionSnapshot,
  applyP2PConnectionStatus,
  bindP2PConnectionStatusBridge,
  resolveP2PConnectionHealth,
  useP2PStore,
} from "../useP2PStore";

describe("useP2PStore", () => {
  afterEach(() => {
    useP2PStore.getState().resetConnectionStates();
  });

  it("maps ConnectionManager states to UI health", () => {
    expect(resolveP2PConnectionHealth("idle")).toBe("idle");
    expect(resolveP2PConnectionHealth("connecting")).toBe("connecting");
    expect(resolveP2PConnectionHealth("connected")).toBe("online");
    expect(resolveP2PConnectionHealth("reconnecting")).toBe("degraded");
    expect(resolveP2PConnectionHealth("closed")).toBe("offline");
  });

  it("publishes conversation connection snapshots", () => {
    const publish = createP2PConnectionStatePublisher(() => 1234);

    publish("conv-1", "connected", "handshake-complete");

    expect(getP2PConnectionSnapshot("conv-1")).toEqual({
      convId: "conv-1",
      state: "connected",
      health: "online",
      connected: true,
      detail: "handshake-complete",
      lastChangedAt: 1234,
    });
  });

  it("applies main-process connection status payloads", () => {
    applyP2PConnectionStatus({
      convId: "conv-1",
      state: "reconnecting",
      detail: "socket-closed",
      changedAt: 5678,
    });

    expect(getP2PConnectionSnapshot("conv-1")?.health).toBe("degraded");
    expect(getP2PConnectionSnapshot("conv-1")?.lastChangedAt).toBe(5678);
  });

  it("binds a validated IPC bridge payload into the store", () => {
    const unsubscribe = bindP2PConnectionStatusBridge({
      onConnectionStatus: (cb) => {
        cb({
          convId: "conv-1",
          state: "connected",
          changedAt: 90,
        });
        cb({
          convId: "conv-2",
          state: "invalid",
          changedAt: 91,
        });
        return () => undefined;
      },
    });

    expect(getP2PConnectionSnapshot("conv-1")?.connected).toBe(true);
    expect(getP2PConnectionSnapshot("conv-2")).toBeNull();
    unsubscribe();
  });

  it("removes and resets connection snapshots", () => {
    const state = useP2PStore.getState();
    state.setConnectionState("conv-1", "connected", undefined, 1);
    state.setConnectionState("conv-2", "reconnecting", undefined, 2);

    useP2PStore.getState().removeConnectionState("conv-1");
    expect(getP2PConnectionSnapshot("conv-1")).toBeNull();
    expect(getP2PConnectionSnapshot("conv-2")?.state).toBe("reconnecting");

    useP2PStore.getState().resetConnectionStates();
    expect(useP2PStore.getState().connectionsByConvId).toEqual({});
  });
});
