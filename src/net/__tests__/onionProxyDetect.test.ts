import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetConfig } from "../netConfig";

vi.mock("../proxyControl", async () => {
  const actual = await vi.importActual<typeof import("../proxyControl")>(
    "../proxyControl"
  );
  return {
    ...actual,
    applyProxyConfig: vi.fn(),
    checkProxyHealth: vi.fn(),
    isLocalhostProxy: vi.fn(),
  };
});

import { detectLocalOnionProxy } from "../onionProxyDetect";
import { applyProxyConfig, checkProxyHealth, isLocalhostProxy } from "../proxyControl";

const mockedApplyProxyConfig = vi.mocked(applyProxyConfig);
const mockedCheckProxyHealth = vi.mocked(checkProxyHealth);
const mockedIsLocalhostProxy = vi.mocked(isLocalhostProxy);

const baseConfig: NetConfig = {
  mode: "onionRouter",
  onionProxyEnabled: true,
  onionProxyUrl: "",
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
};

describe("onionProxyDetect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers user-provided proxy URL", async () => {
    mockedIsLocalhostProxy.mockReturnValue(true);
    mockedCheckProxyHealth.mockResolvedValue({ ok: true, message: "ok" });

    const config = { ...baseConfig, onionProxyUrl: "socks5://127.0.0.1:9050" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBe("socks5://127.0.0.1:9050");
    expect(mockedApplyProxyConfig).toHaveBeenCalled();
  });

  it("falls back to well-known localhost candidates", async () => {
    mockedIsLocalhostProxy.mockReturnValue(true);
    mockedCheckProxyHealth
      .mockResolvedValueOnce({ ok: false, message: "nope" })
      .mockResolvedValueOnce({ ok: true, message: "ok" });

    const config = { ...baseConfig, onionProxyUrl: "" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBe("socks5://localhost:9050");
  });

  it("rejects proxy URLs missing a port", async () => {
    mockedIsLocalhostProxy.mockReturnValue(true);

    const config = { ...baseConfig, onionProxyUrl: "socks5://127.0.0.1" };

    await expect(detectLocalOnionProxy(config)).rejects.toThrow("Invalid proxy URL");
    expect(mockedApplyProxyConfig).not.toHaveBeenCalled();
  });

  it("rejects remote proxy without opt-in", async () => {
    mockedIsLocalhostProxy.mockReturnValue(false);
    const config = { ...baseConfig, onionProxyUrl: "http://1.2.3.4:9050" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBeNull();
    expect(mockedApplyProxyConfig).not.toHaveBeenCalled();
  });
});
