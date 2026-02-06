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

  it("falls back to selfOnion when directP2P send fails in direct mode", async () => {
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
    const selfOnionTransport = createTransport("selfOnion");
    const result = await router.sendCiphertext(
      {
        convId: "c1",
        messageId: "m1c",
        ciphertext: "enc",
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
        transports: { directP2P: directTransport, selfOnion: selfOnionTransport },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("selfOnion");
    expect(directTransport.send).toHaveBeenCalledTimes(1);
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
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
});
