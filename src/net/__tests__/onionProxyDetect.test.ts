import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetConfig } from "../netConfig";

vi.mock("../proxyControl", () => {
  return {
    applyProxyConfig: vi.fn(),
    checkProxyHealth: vi.fn(),
    isLocalhostProxy: vi.fn(),
  };
});

import { detectLocalOnionProxy } from "../onionProxyDetect";
import { applyProxyConfig, checkProxyHealth, isLocalhostProxy } from "../proxyControl";

const baseConfig: NetConfig = {
  mode: "onionRouter",
  onionProxyEnabled: true,
  onionProxyUrl: "",
  webrtcRelayOnly: true,
  disableLinkPreview: true,
  selfOnionEnabled: true,
  selfOnionMinRelays: 5,
  allowRemoteProxy: false,
};

describe("onionProxyDetect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers user-provided proxy URL", async () => {
    isLocalhostProxy.mockReturnValue(true);
    checkProxyHealth.mockResolvedValue({ ok: true, message: "ok" });

    const config = { ...baseConfig, onionProxyUrl: "socks5://127.0.0.1:9050" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBe("socks5://127.0.0.1:9050");
    expect(applyProxyConfig).toHaveBeenCalled();
  });

  it("falls back to well-known localhost candidates", async () => {
    isLocalhostProxy.mockReturnValue(true);
    checkProxyHealth
      .mockResolvedValueOnce({ ok: false, message: "nope" })
      .mockResolvedValueOnce({ ok: true, message: "ok" });

    const config = { ...baseConfig, onionProxyUrl: "" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBe("socks5://localhost:9050");
  });

  it("rejects remote proxy without opt-in", async () => {
    isLocalhostProxy.mockReturnValue(false);
    const config = { ...baseConfig, onionProxyUrl: "http://1.2.3.4:9050" };
    const result = await detectLocalOnionProxy(config);

    expect(result).toBeNull();
    expect(applyProxyConfig).not.toHaveBeenCalled();
  });
});
