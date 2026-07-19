import type { NativeWorkerClient } from "./nativeWorkerClient";

export type SocksFetchOptions = {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  socksProxyUrl: string;
  retry?: {
    attempts?: number;
    delayMs?: number;
  };
  onAttemptStart?: (detail: { attempt: number; maxAttempts: number; url: string }) => void;
  onAttemptSuccess?: (detail: {
    attempt: number;
    maxAttempts: number;
    url: string;
    status: number;
  }) => void;
  onAttemptFailure?: (detail: {
    attempt: number;
    maxAttempts: number;
    url: string;
    error: Error;
    retryDelayMs: number | null;
  }) => void;
};

export type SocksFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type SocksFetch = (
  url: string,
  options: SocksFetchOptions
) => Promise<SocksFetchResponse>;

export type SocksTransport = {
  fetch: SocksFetch;
  forward: (
    payload: unknown,
    options: {
      torProxyUrl?: string | null;
      alternateRouteProxyUrl?: string | null;
      queueOnFailure?: boolean;
    }
  ) => Promise<{
    status: number;
    body: Record<string, unknown>;
    traces?: Array<Record<string, unknown> & { event: string }>;
  }>;
  clearProxy: (proxyUrl?: string | null) => Promise<void>;
};

type NativeFetchResult = {
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  attempts?: number;
};

export const createNativeSocksTransport = (
  client: Pick<NativeWorkerClient, "request">
): SocksTransport => ({
  fetch: async (url, options) => {
    const maxAttempts = Math.max(1, Math.min(3, options.retry?.attempts ?? 1));
    options.onAttemptStart?.({ attempt: 1, maxAttempts, url });
    try {
      const result = await client.request<NativeFetchResult>(
        "transport.fetch",
        {
          url,
          method: options.method,
          headers: options.headers ?? {},
          bodyBase64: options.body?.toString("base64") ?? "",
          timeoutMs: options.timeoutMs ?? 45_000,
          socksProxyUrl: options.socksProxyUrl,
          retry: {
            attempts: maxAttempts,
            delayMs: Math.max(0, options.retry?.delayMs ?? 0),
          },
        },
        Math.max(5_000, (options.timeoutMs ?? 45_000) * maxAttempts + 5_000)
      );
      const attempt = Math.max(1, Math.min(maxAttempts, result.attempts ?? 1));
      options.onAttemptSuccess?.({ attempt, maxAttempts, url, status: result.status });
      return {
        status: result.status,
        headers: result.headers ?? {},
        body: Buffer.from(result.bodyBase64 ?? "", "base64"),
      };
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      options.onAttemptFailure?.({
        attempt: maxAttempts,
        maxAttempts,
        url,
        error,
        retryDelayMs: null,
      });
      throw error;
    }
  },
  forward: async (payload, options) =>
    client.request(
      "transport.forward",
      {
        payload,
        torProxyUrl: options.torProxyUrl?.trim() ?? "",
        alternateRouteProxyUrl: options.alternateRouteProxyUrl?.trim() ?? "",
        queueOnFailure: options.queueOnFailure ?? true,
      },
      95_000
    ),
  clearProxy: async (proxyUrl) => {
    await client.request("transport.clearProxy", { proxyUrl: proxyUrl?.trim() ?? "" }, 5_000);
  },
});
