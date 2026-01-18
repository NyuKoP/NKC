import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_NET_CONFIG } from "../netConfig";
import { applyProxyConfig, checkProxyHealth } from "../proxyControl";

describe("proxyControl", () => {
  const applyProxy = vi.fn().mockResolvedValue(undefined);
  const checkProxy = vi.fn().mockResolvedValue({ ok: true, message: "ok" });
  type SecureProxyWindow = {
    secureProxy: {
      applyProxy: typeof applyProxy;
      checkProxy: typeof checkProxy;
    };
  };

  beforeEach(() => {
    (globalThis as unknown as { window?: SecureProxyWindow }).window = {
      secureProxy: { applyProxy, checkProxy },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies proxy config via IPC bridge", async () => {
    await applyProxyConfig({
      ...DEFAULT_NET_CONFIG,
      mode: "onionRouter",
      onionProxyEnabled: true,
      onionProxyUrl: "socks5://127.0.0.1:9050",
    });
    expect(applyProxy).toHaveBeenCalledWith({
      proxyUrl: "socks5://127.0.0.1:9050",
      enabled: true,
      allowRemote: false,
    });
  });

  it("checks proxy health via IPC bridge", async () => {
    const status = await checkProxyHealth();
    expect(status.ok).toBe(true);
  });
});
