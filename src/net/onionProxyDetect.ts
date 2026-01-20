import type { NetConfig } from "./netConfig";
import { applyProxyConfig, checkProxyHealth, isLocalhostProxy } from "./proxyControl";

const LOCAL_CANDIDATES = [
  "socks5://127.0.0.1:9050",
  "socks5://localhost:9050",
];

const tryProxy = async (config: NetConfig, proxyUrl: string) => {
  try {
    await applyProxyConfig({
      ...config,
      mode: "onionRouter",
      onionProxyEnabled: true,
      onionProxyUrl: proxyUrl,
    });
    const health = await checkProxyHealth();
    return health.ok;
  } catch {
    return false;
  }
};

export const detectLocalOnionProxy = async (config: NetConfig) => {
  const userUrl = config.onionProxyUrl?.trim();
  if (userUrl) {
    if (!config.allowRemoteProxy && !isLocalhostProxy(userUrl)) {
      return null;
    }
    if (await tryProxy(config, userUrl)) return userUrl;
  }

  for (const candidate of LOCAL_CANDIDATES) {
    if (await tryProxy(config, candidate)) return candidate;
  }

  return null;
};
