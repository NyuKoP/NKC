import { beforeEach, describe, expect, it, vi } from "vitest";

type OutboxRecord = {
  id: string;
  convId: string;
  ciphertext: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAttemptAtMs?: number;
  attempts: number;
  status: "pending" | "acked" | "expired";
};

const createTransport = (sendImpl?: () => Promise<void>) => {
  const transport = {
    name: "directP2P",
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

  it("blocks direct P2P when onionRouter mode is active", async () => {
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
    const directTransport = createTransport();
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
          mode: "onionRouter",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: true,
          disableLinkPreview: true,
          selfOnionEnabled: true,
          selfOnionMinRelays: 5,
          allowRemoteProxy: false,
        },
        transports: { directP2P: directTransport as any },
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch("Direct P2P blocked");
  });

  it("retries onionRouter once after selfOnion failure in auto mode", async () => {
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
    const selfOnionTransport = createTransport(failSend);
    const onionRouterTransport = createTransport();

    const reported: string[] = [];
    const routeController = {
      decideTransport: () => "selfOnion",
      reportAck: () => {},
      reportSendFail: (kind: string) => {
        reported.push(kind);
      },
      reportRouteBuildFail: () => {},
      reportRelayPoolSize: () => {},
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
          mode: "auto",
          onionProxyEnabled: true,
          onionProxyUrl: "socks5://127.0.0.1:9050",
          webrtcRelayOnly: false,
          disableLinkPreview: false,
          selfOnionEnabled: true,
          selfOnionMinRelays: 5,
          allowRemoteProxy: false,
        },
        routeController: routeController as any,
        transports: {
          selfOnion: selfOnionTransport as any,
          onionRouter: onionRouterTransport as any,
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("onionRouter");
    expect(selfOnionTransport.send).toHaveBeenCalledTimes(1);
    expect(onionRouterTransport.send).toHaveBeenCalledTimes(1);
    expect(reported).toContain("selfOnion");
  });
});
