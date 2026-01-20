import type { NetConfig } from "./netConfig";

type ProxyHealth = {
  ok: boolean;
  message: string;
};

type ProxyBridge = {
  applyProxy: (payload: { proxyUrl: string; enabled: boolean; allowRemote: boolean }) => Promise<void>;
  checkProxy: () => Promise<ProxyHealth>;
};

const getBridge = (): ProxyBridge | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { secureProxy?: ProxyBridge };
  return w.secureProxy ?? null;
};

export const isLocalhostProxy = (proxyUrl: string) => {
  try {
    const parsed = new URL(proxyUrl);
    const hostname = parsed.hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
};

export const applyProxyConfig = async (config: NetConfig) => {
  const bridge = getBridge();
  if (!bridge) return;
  if (config.onionProxyEnabled && !config.allowRemoteProxy && !isLocalhostProxy(config.onionProxyUrl)) {
    console.warn("[proxy] Remote proxy blocked without opt-in.");
    throw new Error("Remote proxy blocked");
  }
  await bridge.applyProxy({
    proxyUrl: config.onionProxyUrl,
    enabled: config.onionProxyEnabled && config.mode === "onionRouter",
    allowRemote: config.allowRemoteProxy,
  });
};

export const checkProxyHealth = async (): Promise<ProxyHealth> => {
  const bridge = getBridge();
  if (!bridge) return { ok: false, message: "not-available" };
  return bridge.checkProxy();
};
