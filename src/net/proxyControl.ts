import type { NetConfig } from "./netConfig";

type ProxyHealth = {
  ok: boolean;
  message: string;
};

type ProxyBridge = {
  applyProxy: (payload: { proxyUrl: string; enabled: boolean; allowRemote: boolean }) => Promise<void>;
  checkProxy: () => Promise<ProxyHealth>;
};

const ALLOWED_PROXY_PROTOCOLS = new Set(["socks5:", "socks5h:", "http:", "https:"]);

const getBridge = (): ProxyBridge | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { secureProxy?: ProxyBridge };
  return w.secureProxy ?? null;
};

const isLocalhostHost = (hostname: string) =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

export const isLocalhostProxy = (proxyUrl: string) => {
  try {
    const parsed = new URL(proxyUrl);
    return isLocalhostHost(parsed.hostname);
  } catch {
    return false;
  }
};

export const validateProxyUrl = (input: string) => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Invalid proxy URL");
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error("Invalid proxy URL");
  }
  if (!url.hostname || !url.port) {
    throw new Error("Invalid proxy URL");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy URL");
  }
  return { url, normalized: `${url.protocol}//${url.host}` };
};

export const applyProxyConfig = async (config: NetConfig) => {
  const bridge = getBridge();
  if (!bridge) return;
  if (config.onionProxyEnabled) {
    const { url, normalized } = validateProxyUrl(config.onionProxyUrl);
    if (!config.allowRemoteProxy && !isLocalhostHost(url.hostname)) {
      console.warn("[proxy] Remote proxy blocked without opt-in.");
      throw new Error("Remote proxy blocked");
    }
    await bridge.applyProxy({
      proxyUrl: normalized,
      enabled: config.onionProxyEnabled && config.mode === "onionRouter",
      allowRemote: config.allowRemoteProxy,
    });
    return;
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
