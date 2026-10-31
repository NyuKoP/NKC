import { isLocalhostHost, validateProxyUrl } from "./proxyUrl";
import type { NetConfig } from "./netConfig";

export { validateProxyUrl } from "./proxyUrl";

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

  return window.secureProxy ?? null;
};

export const isLocalhostProxy = (proxyUrl: string) => {
  try {
    const parsed = new URL(proxyUrl);

    return isLocalhostHost(parsed.hostname);
  } catch {
    return false;
  }
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
