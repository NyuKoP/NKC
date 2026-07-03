import { describe, expect, it, vi } from "vitest";
import { TorRuntime } from "../TorRuntime";

const DATA_DIR_CONFLICT_DETAIL = "another Tor process is running with the same data directory";

describe("TorRuntime", () => {
  it("shares a single in-flight start() promise for concurrent callers", async () => {
    let status: unknown = { state: "unavailable" };
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => resolve();
    });

    const startTor = vi.fn(async () => {
      await startGate;
      status = {
        state: "running",
        socksProxyUrl: "socks5://127.0.0.1:9050",
        dataDir: "C:/tmp/nkc-tor",
      };
    });

    const runtime = new TorRuntime({
      getBridge: () => ({
        getTorStatus: async () => status,
        startTor,
        setOnionForwardProxy: async () => {},
      }),
      checkProxyReachable: async () => true,
      sleep: async () => {},
      now: () => Date.now(),
      log: () => {},
    });

    const p1 = runtime.start();
    const p2 = runtime.start();
    const p3 = runtime.start();
    releaseStart();
    await Promise.all([p1, p2, p3]);

    expect(startTor).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toBe("READY");
  });

  it("retries with profile-scoped DataDirectory after conflict", async () => {
    let status: unknown = {
      state: "failed",
      details: DATA_DIR_CONFLICT_DETAIL,
    };

    const startTor = vi.fn(async (opts?: { profileScopedDataDir?: boolean }) => {
      if (opts?.profileScopedDataDir) {
        status = {
          state: "running",
          socksProxyUrl: "socks5://127.0.0.1:19050",
          dataDir: "C:/tmp/nkc-tor-profile-1234",
        };
        return;
      }
      status = {
        state: "failed",
        details: DATA_DIR_CONFLICT_DETAIL,
      };
    });

    const runtime = new TorRuntime({
      getBridge: () => ({
        getTorStatus: async () => status,
        startTor,
        setOnionForwardProxy: async () => {},
      }),
      checkProxyReachable: async (socksUrl) => socksUrl.includes(":19050"),
      sleep: async () => {},
      now: (() => {
        let clock = 0;
        return () => {
          clock += 40;
          return clock;
        };
      })(),
      log: () => {},
    });

    await runtime.start({ timeoutMs: 600 });
    expect(startTor).toHaveBeenCalledTimes(2);
    expect(startTor.mock.calls[1][0]).toEqual({ profileScopedDataDir: true });
    expect(runtime.getState()).toBe("READY");
    expect(runtime.getSocksUrl()).toBe("socks5://127.0.0.1:19050");
  });

  it("awaitReady() times out when Tor never becomes ready", async () => {
    const runtime = new TorRuntime({
      getBridge: () => ({
        getTorStatus: async () => ({ state: "starting" }),
        startTor: async () => {},
      }),
      checkProxyReachable: async () => false,
      sleep: async () => {},
      now: (() => {
        let clock = 0;
        return () => {
          clock += 120;
          return clock;
        };
      })(),
      log: () => {},
    });

    await expect(runtime.awaitReady(500)).rejects.toMatchObject({
      code: "TOR_NOT_READY",
    });
    expect(runtime.getState()).toBe("DEGRADED");
  });
});
