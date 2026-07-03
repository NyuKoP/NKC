import { useNetConfigStore } from "./netConfigStore";
import { checkProxyHealth } from "./proxyControl";
import { fetchWithTimeout } from "./fetchWithTimeout";

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
      const timeoutMs = 15_000;
      const { signal: parentSignal, ...requestInit } = init ?? {};
      return fetchWithTimeout(url, requestInit, {
        timeoutMs,
        parentSignal: parentSignal ?? undefined,
        opId: url,
        traceSource: "http-client",
      });
    },
    async healthCheck() {
      return checkProxyHealth();
    },
  };
};
