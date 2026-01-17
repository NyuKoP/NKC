export type HttpClient = {
  request: (url: string, init?: RequestInit) => Promise<Response>;
};

type HttpClientOptions = {
  proxyEnabled?: boolean;
  proxyUrl?: string;
};

// Proxy handling is stubbed for now; Electron networking can wire this later.
export const createHttpClient = ({ proxyEnabled, proxyUrl }: HttpClientOptions = {}): HttpClient => {
  const baseProxyUrl = proxyEnabled && proxyUrl ? proxyUrl : "";
  return {
    request: (url, init) => {
      const finalUrl = baseProxyUrl ? new URL(url, baseProxyUrl).toString() : url;
      return fetch(finalUrl, init);
    },
  };
};
