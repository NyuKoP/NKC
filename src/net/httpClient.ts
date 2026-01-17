import { useNetConfigStore } from "./netConfigStore";
import { checkProxyHealth } from "./proxyControl";

export type HttpClient = {
  request: (url: string, init?: RequestInit, options?: RequestOptions) => Promise<Response>;
  healthCheck: () => Promise<{ ok: boolean; message: string }>;
};

type RequestOptions = {
  kind?: "default" | "linkPreview";
};

export const createHttpClient = (): HttpClient => {
  return {
    async request(url, init, options) {
      const config = useNetConfigStore.getState().config;
      if (config.mode === "onionRouter" && !config.onionProxyEnabled) {
        console.warn("[net] Onion router mode requires proxy.");
        throw new Error("Onion proxy required");
      }
      if (options?.kind === "linkPreview" && config.disableLinkPreview) {
        console.warn("[net] Link preview blocked by privacy settings.");
        throw new Error("Link preview disabled");
      }
      return fetch(url, init);
    },
    async healthCheck() {
      return checkProxyHealth();
    },
  };
};
