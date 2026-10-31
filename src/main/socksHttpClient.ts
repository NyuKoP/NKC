import type { NativeWorkerClient } from "./nativeWorkerClient";
import { createHash } from "node:crypto";
import { decodeBinaryTransportPacketV2, decodeInboxTransportPacket } from "../adapters/transports/packetCodec";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../net/mediaTransferLimits";
import { decodeBase64Url } from "../security/base64url";

export const ownedRetryId = (messageId: string, ciphertext: string | Uint8Array) =>
  `owned:${createHash("sha256").update(messageId).update("\0").update(ciphertext).digest("hex")}`;

export const ownedBinaryRetryId = (packetBytes: Uint8Array) =>
  `owned-binary-v1:${createHash("sha256").update("NKC|OWNED-BINARY|1\0").update(packetBytes).digest("hex")}`;

export type SocksFetchOptions = {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  diagnose?: boolean;
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

type OnionForwardResult = {
  status: number;
  body: Record<string, unknown>;
  traces?: Array<Record<string, unknown> & { event: string }>;
};

export type SocksTransport = {
  fetch: SocksFetch;
  forward: (
    payload: unknown,
    options: {
      torProxyUrl?: string | null;
      queueOnFailure?: boolean;
      owner?: { accountId: string; sessionToken?: string; assertCurrent: () => void };
    }
  ) => Promise<OnionForwardResult>;
  clearProxy: (proxyUrl?: string | null) => Promise<void>;
};

type NativeFetchResult = {
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  attempts?: number;
};

export const createNativeSocksTransport = (
  client: Pick<NativeWorkerClient, "request"> & Partial<Pick<NativeWorkerClient, "requestBinary">>,
  transportOptions?: { getAccountId?: () => string; onForwardResult?: (payload: unknown, result: OnionForwardResult) => void }
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
          ...(options.diagnose ? { diagnose: true } : {}),
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
  forward: async (payload, options) => {
    options.owner?.assertCurrent();

    if (payload && typeof payload === "object" && "envelope" in payload && payload.envelope instanceof Uint8Array) {
      if (!options.owner?.sessionToken || !client.requestBinary || payload.envelope.byteLength > ONION_TRANSFER_MAX_BODY_BYTES) {
        throw new Error("BINARY_FORWARD_AUTHORITY_REQUIRED");
      }

      const body = Buffer.from(payload.envelope);
      decodeBinaryTransportPacketV2(body);
      const route = { ...payload, envelope: undefined };

      const response = await client.requestBinary<OnionForwardResult>(
        "transport.forward.binary", {
          payload: route, payloadFormat: "nkcp-v2", ownedRetryId: ownedBinaryRetryId(body),
          accountId: options.owner.accountId, sessionToken: options.owner.sessionToken,
          torProxyUrl: options.torProxyUrl?.trim() ?? "", queueOnFailure: options.queueOnFailure ?? true,
        }, body, 95_000
      );

      options.owner.assertCurrent();

      return response.result;
    }

    const wire = payload as { envelope?: string };
    const packet = options.owner && typeof wire?.envelope === "string" ? decodeInboxTransportPacket(wire.envelope) : null;
    const ciphertext = packet?.payload;

    const retryId = packet && ciphertext !== undefined ? ownedRetryId(packet.id,
      typeof ciphertext === "object" && !(ciphertext instanceof Uint8Array) ? decodeBase64Url(ciphertext.b64) : ciphertext) : undefined;

    const params = {
      torProxyUrl: options.torProxyUrl?.trim() ?? "",
      queueOnFailure: options.queueOnFailure ?? true,
      ...(retryId ? { ownedRetryId: retryId } : {}),
      ...(options.owner?.sessionToken ? { sessionToken: options.owner.sessionToken } : {}),
      ...(process.env.NKC_COLD_START_TRACE === "1" ? { diagnose: true } : {}),
      ...(options.owner || transportOptions?.getAccountId
        ? { accountId: options.owner?.accountId ?? transportOptions?.getAccountId?.() }
        : {}),
    };

    if (client.requestBinary) {
      const response = await client.requestBinary<OnionForwardResult>(
        "transport.forward.binary",
        params,
        Buffer.from(JSON.stringify(payload), "utf8"),
        95_000
      );

      try { transportOptions?.onForwardResult?.(payload, response.result); } catch { /* Passive diagnosis. */ }

      return response.result;
    }

    const result = await client.request<OnionForwardResult>(
      "transport.forward",
      { payload, ...params },
      95_000
    );

    try { transportOptions?.onForwardResult?.(payload, result); } catch { /* Passive diagnosis. */ }

    return result;
  },
  clearProxy: async (proxyUrl) => {
    await client.request("transport.clearProxy", { proxyUrl: proxyUrl?.trim() ?? "" }, 5_000);
  },
});
