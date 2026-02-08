import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testResetRouter } from "../router";
import { createRouteController } from "../routeController";
import type { Transport } from "../../adapters/transports/types";

type OutboxRecord = {
  id: string;
  convId: string;
  ciphertext: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAttemptAtMs?: number;
  nextAttemptAtMs: number;
  attempts: number;
  status: "pending" | "in_flight" | "acked" | "expired";
  inFlightAtMs?: number;
  ackDeadlineMs?: number;
};

const createTransport = (
  name: Transport["name"] = "selfOnion",
  sendImpl?: () => Promise<void>
): Transport => {
  const transport: Transport = {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async () => {
      if (sendImpl) await sendImpl();
    }),
    onMessage: vi.fn(),
    onAck: vi.fn(),
    onState: vi.fn(),
  };
  return transport;
};

describe("router", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    __testResetRouter();
  });

  it("uses directP2P when direct mode is selected", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const directTransport = createTransport("directP2P");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "directP2P",
        config: {
          mode: "directP2P",
          onionProxyEnabled: false,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: false,
          disableLinkPreview: false,
          selfOnionEnabled: true,
          selfOnionMinRelays: 3,
          allowRemoteProxy: false,
          onionEnabled: false,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        transports: { directP2P: directTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("directP2P");
    expect(directTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("skips transport attempts when destination is missing", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "missing-to",
        ciphertext: "enc",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
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
        transports: { onionRouter: onionRouterTransport },
      }
    );

    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("FATAL_MISCONFIG");
    expect(onionRouterTransport.send).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("falls back to onionRouter when directP2P is blocked", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const directTransport = createTransport("directP2P");
    const onionRouterTransport = createTransport("onionRouter");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1b",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "directP2P",
        config: {
          mode: "onionRouter",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: true,
          disableLinkPreview: true,
          selfOnionEnabled: true,
          selfOnionMinRelays: 3,
          allowRemoteProxy: false,
          onionEnabled: false,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        transports: { directP2P: directTransport, onionRouter: onionRouterTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("onionRouter");
    expect(directTransport.send).not.toHaveBeenCalled();
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("falls back to onionRouter when directP2P send fails in direct mode", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const directTransport = createTransport("directP2P", async () => {
      throw new Error("direct channel not open");
    });
    const onionRouterTransport = createTransport("onionRouter");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1c",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "directP2P",
        config: {
          mode: "directP2P",
          onionProxyEnabled: false,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: false,
          disableLinkPreview: false,
          selfOnionEnabled: true,
          selfOnionMinRelays: 3,
          allowRemoteProxy: false,
          onionEnabled: false,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        transports: { directP2P: directTransport, onionRouter: onionRouterTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("onionRouter");
    expect(directTransport.send).toHaveBeenCalledTimes(1);
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("falls back to directP2P when onionRouter has no route target", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter", async () => {
      throw new Error("forward_failed:no_route_target");
    });
    const directTransport = createTransport("directP2P");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1d",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
        config: {
          mode: "onionRouter",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: true,
          disableLinkPreview: true,
          selfOnionEnabled: true,
          selfOnionMinRelays: 3,
          allowRemoteProxy: false,
          onionEnabled: false,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        transports: { onionRouter: onionRouterTransport, directP2P: directTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("directP2P");
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(directTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("falls back to selfOnion when onionRouter reports no_route", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter", async () => {
      throw new Error("forward_failed:no_route");
    });
    const selfOnionTransport = createTransport("selfOnion");
    const directTransport = createTransport("directP2P", async () => {
      throw new Error("direct channel not open");
    });
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1d-no-route",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
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
        transports: {
          onionRouter: onionRouterTransport,
          selfOnion: selfOnionTransport,
          directP2P: directTransport,
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("selfOnion");
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(directTransport.send).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("falls back to selfOnion when onionRouter proxy is unreachable", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter", async () => {
      throw new Error("forward_failed:proxy_unreachable");
    });
    const directTransport = createTransport("directP2P", async () => {
      throw new Error("direct channel not open");
    });
    const selfOnionTransport = createTransport("selfOnion");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1e",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
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
        transports: {
          onionRouter: onionRouterTransport,
          directP2P: directTransport,
          selfOnion: selfOnionTransport,
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("selfOnion");
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(directTransport.send).not.toHaveBeenCalled();
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("falls back to selfOnion when onionRouter send is aborted", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter", async () => {
      throw new Error("onionrouter: This operation was aborted");
    });
    const directTransport = createTransport("directP2P", async () => {
      throw new Error("direct channel not open");
    });
    const selfOnionTransport = createTransport("selfOnion");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1e-aborted",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
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
        transports: {
          onionRouter: onionRouterTransport,
          directP2P: directTransport,
          selfOnion: selfOnionTransport,
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("selfOnion");
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(directTransport.send).not.toHaveBeenCalled();
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("defers when selfOnion is not ready without direct fallback", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter", async () => {
      throw new Error("forward_failed:proxy_unreachable");
    });
    const selfOnionTransport = createTransport("selfOnion", async () => {
      const error = new Error("INTERNAL_ONION_NOT_READY: Internal onion route is not ready") as Error & {
        code?: string;
      };
      error.code = "INTERNAL_ONION_NOT_READY";
      throw error;
    });
    const directTransport = createTransport("directP2P", async () => {
      throw new Error("direct channel not open");
    });

    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1e-retry",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "onionRouter",
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
        transports: {
          onionRouter: onionRouterTransport,
          selfOnion: selfOnionTransport,
          directP2P: directTransport,
        },
      }
    );

    expect(result.ok).toBe(false);
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(directTransport.send).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
    expect(String((result as { error?: string }).error)).toContain("RETRYABLE_SEND_FAILURE");
  });

  it("retries onionRouter once after selfOnion failure in built-in onion mode", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const failSend = vi.fn(async () => {
      throw new Error("self-onion failed");
    });
    const selfOnionTransport = createTransport("selfOnion", failSend);
    const onionRouterTransport = createTransport("onionRouter");

    const reported: string[] = [];
    const routeController = createRouteController();
    routeController.decideTransport = () => "selfOnion";
    routeController.reportSendFail = (kind: string) => {
      reported.push(kind);
    };

    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m2",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        config: {
          mode: "selfOnion",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: false,
          disableLinkPreview: false,
          selfOnionEnabled: true,
          selfOnionMinRelays: 5,
          allowRemoteProxy: false,
          onionEnabled: false,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        routeController,
        transports: {
          selfOnion: selfOnionTransport,
          onionRouter: onionRouterTransport,
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("onionRouter");
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(reported).toContain("selfOnion");
    expect(store.has("m2")).toBe(true);
    const selfOrder = (
      selfOnionTransport.send as unknown as { mock?: { invocationCallOrder?: number[] } }
    ).mock?.invocationCallOrder?.[0];
    const onionOrder = (
      onionRouterTransport.send as unknown as { mock?: { invocationCallOrder?: number[] } }
    ).mock?.invocationCallOrder?.[0];
    if (selfOrder !== undefined && onionOrder !== undefined) {
      expect(selfOrder).toBeLessThan(onionOrder);
    }
  });

  it("blocks selfOnion when onion router is enabled", async () => {
    const store = new Map<string, OutboxRecord>();
    vi.doMock("../../storage/outboxStore", () => {
      return {
        putOutbox: async (record: OutboxRecord) => {
          store.set(record.id, record);
        },
        deleteOutbox: async (id: string) => {
          store.delete(id);
        },
        deleteExpiredOutbox: async () => 0,
      };
    });

    const router = await import("../router");
    const selfOnionTransport = createTransport("selfOnion");
    const onionRouterTransport = createTransport("onionRouter");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m3",
        ciphertext: "enc",
        toDeviceId: "peer-device",
        priority: "high",
      },
      {
        resolveTransport: () => "selfOnion",
        config: {
          mode: "selfOnion",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: true,
          disableLinkPreview: true,
          selfOnionEnabled: true,
          selfOnionMinRelays: 5,
          allowRemoteProxy: false,
          onionEnabled: true,
          onionSelectedNetwork: "tor",
          tor: { installed: true, status: "ready", version: "1.0.0" },
          lokinet: { installed: false, status: "idle" },
          lastUpdateCheckAtMs: undefined,
        },
        transports: { selfOnion: selfOnionTransport, onionRouter: onionRouterTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("onionRouter");
    expect(selfOnionTransport.send).not.toHaveBeenCalled();
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it("prewarms chosen and fallback transports in onion mode", async () => {
    const router = await import("../router");
    const onionRouterTransport = createTransport("onionRouter");
    const directTransport = createTransport("directP2P");
    const selfOnionTransport = createTransport("selfOnion");

    const warmup = await router.prewarmRouter({
      resolveTransport: () => "onionRouter",
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
      transports: {
        onionRouter: onionRouterTransport,
        directP2P: directTransport,
        selfOnion: selfOnionTransport,
      },
    });

    expect(warmup.chosenTransport).toBe("onionRouter");
    expect(warmup.requested).toEqual(["onionRouter", "directP2P", "selfOnion"]);
    expect(warmup.failed).toEqual([]);
    expect(warmup.started).toEqual(["onionRouter", "directP2P", "selfOnion"]);
    expect(onionRouterTransport.start).toHaveBeenCalledTimes(1);
    expect(directTransport.start).toHaveBeenCalledTimes(1);
    expect(selfOnionTransport.start).toHaveBeenCalledTimes(1);
  });
});

