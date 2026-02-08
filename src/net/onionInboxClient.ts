import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { createTransportError, getTransportErrorCode } from "./transportErrors";
import { createId } from "../utils/ids";

export type OnionInboxConfig = {
  baseUrl: string;
  deviceId: string;
  timeoutMs?: number;
};

type PollerHandlers = {
  onResult: (result: PollResponse) => void;
  onError: (error: string) => void;
};

type PollerHandle = {
  stop: () => void;
};

type HealthResponse = {
  ok: boolean;
  network: "tor" | "lokinet" | "none";
  details?: string;
  tor?: {
    active: boolean;
    socksProxy?: string | null;
    address?: string;
    details?: string;
  };
  lokinet?: {
    active: boolean;
    proxyUrl?: string | null;
    address?: string;
    details?: string;
  };
};

type SendResponse = {
  ok: boolean;
  msgId?: string;
  error?: string;
};

type AddressResponse = {
  ok: boolean;
  torOnion?: string;
  lokinet?: string;
  details?: string;
};

type PollResponse = {
  ok: boolean;
  items: Array<{ id: string; ts: number; from: string; envelope: string }>;
  nextAfter: string | null;
  error?: string;
};

type ControllerFetchRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
};

type ControllerFetchResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const safeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "Unknown error");

const DEFAULT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;

const getNkcControllerFetch = () =>
  (
    globalThis as {
      nkc?: {
        onionControllerFetch?: (req: ControllerFetchRequest) => Promise<ControllerFetchResponse>;
      };
    }
  ).nkc?.onionControllerFetch;

export class OnionInboxClient {
  private readonly baseUrl: string;
  private readonly deviceId: string;
  private readonly timeoutMs: number;
  private readonly inFlightRequests = new Map<string, Promise<unknown>>();

  constructor(cfg: OnionInboxConfig) {
    this.baseUrl = cfg.baseUrl;
    this.deviceId = cfg.deviceId;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private toCoalesceKey(path: string) {
    if (path.startsWith("/onion/health")) {
      return "health";
    }
    if (path.startsWith("/onion/inbox")) {
      try {
        const parsed = new URL(path, this.baseUrl);
        const deviceId = parsed.searchParams.get("deviceId") || this.deviceId;
        return `inbox:${deviceId}`;
      } catch {
        return `inbox:${this.deviceId}`;
      }
    }
    return null;
  }

  private formatTransportError(error: unknown) {
    const code = getTransportErrorCode(error);
    if (!code) return safeError(error);
    const message = safeError(error);
    if (message.toLowerCase().includes(code.toLowerCase())) {
      return message;
    }
    return `${code}:${message}`;
  }

  private async requestJson<T>(
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number; operationId?: string },
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const coalesceKey = this.toCoalesceKey(path);
    if (!coalesceKey) {
      return this.requestJsonUncoalesced<T>(path, init, signal);
    }
    const existing = this.inFlightRequests.get(coalesceKey);
    if (existing) {
      return (await existing) as { ok: boolean; status: number; data?: T; error?: string };
    }
    const requestPromise = this.requestJsonUncoalesced<T>(path, init, signal);
    this.inFlightRequests.set(coalesceKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      const current = this.inFlightRequests.get(coalesceKey);
      if (current === requestPromise) {
        this.inFlightRequests.delete(coalesceKey);
      }
    }
  }

  private async requestJsonUncoalesced<T>(
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number; operationId?: string },
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const url = new URL(path, this.baseUrl).toString();
    const body =
      init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const operationId = init.operationId ?? path;

    const controllerFetch = getNkcControllerFetch();
    if (controllerFetch) {
      const abortId = `abort:${createId()}`;
      emitFlowTraceLog({
        event: "abort:linked",
        abortId,
        opId: operationId,
        source: "controller-fetch",
      });
      let onAbort: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        if (signal?.aborted) {
          emitFlowTraceLog({
            event: "abort:fired",
            abortId,
            opId: operationId,
            source: "controller-fetch",
            reason: "aborted-by-parent-signal",
          });
          throw createTransportError("ABORTED_PARENT", "fetch aborted by parent signal");
        }
        const fetchPromise = controllerFetch({
          url,
          method: init.method,
          headers,
          bodyBase64: body ? toBase64(new TextEncoder().encode(body)) : undefined,
          timeoutMs,
        });
        const guards: Array<Promise<never>> = [];
        guards.push(
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              emitFlowTraceLog({
                event: "abort:fired",
                abortId,
                opId: operationId,
                source: "controller-fetch",
                reason: `fetch timeout ${timeoutMs}ms`,
              });
              reject(createTransportError("ABORTED_TIMEOUT", `fetch timeout ${timeoutMs}ms`));
            }, timeoutMs);
          })
        );
        if (signal) {
          guards.push(
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                emitFlowTraceLog({
                  event: "abort:fired",
                  abortId,
                  opId: operationId,
                  source: "controller-fetch",
                  reason: "aborted-by-parent-signal",
                });
                reject(createTransportError("ABORTED_PARENT", "fetch aborted by parent signal"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
            })
          );
        }
        const response = await Promise.race([fetchPromise, ...guards]);
        const decoded = response.bodyBase64
          ? new TextDecoder().decode(fromBase64(response.bodyBase64))
          : "";
        const parsed = decoded ? (JSON.parse(decoded) as T) : undefined;
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          data: parsed,
          error: response.error,
        };
      } catch (error) {
        return { ok: false, status: 0, error: this.formatTransportError(error) };
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: init.method,
          headers,
          body,
        },
        {
          timeoutMs,
          parentSignal: signal,
          opId: operationId,
          traceSource: "fetch",
          onTrace: (trace) => {
            emitFlowTraceLog({
              event: trace.event,
              abortId: trace.abortId,
              opId: trace.opId,
              source: trace.source,
              reason: trace.reason,
            });
          },
        }
      );
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as T) : undefined;
      return { ok: response.ok, status: response.status, data: parsed };
    } catch (error) {
      return { ok: false, status: 0, error: this.formatTransportError(error) };
    }
  }

  async health(): Promise<HealthResponse> {
    const response = await this.requestJson<HealthResponse>("/onion/health", {
      method: "GET",
    });
    if (!response.ok || !response.data) {
      return {
        ok: false,
        network: "none",
        details: response.error ?? "Health check failed",
      };
    }
    return response.data;
  }

  async send(
    toDeviceId: string,
    envelope: string,
    ttlMs?: number,
    route?: { mode: "auto" | "preferLokinet" | "preferTor" | "manual"; torOnion?: string; lokinet?: string },
    signal?: AbortSignal,
    operationId?: string
  ): Promise<SendResponse> {
    const body: Record<string, unknown> = {
      to: route ? undefined : toDeviceId,
      toDeviceId,
      fromDeviceId: this.deviceId,
      envelope,
      ttlMs,
    };
    if (route) {
      body.route = route;
    }
    const sendTimeoutMs = Math.max(this.timeoutMs, SEND_TIMEOUT_MS);
    const response = await this.requestJson<SendResponse>("/onion/send", {
      method: "POST",
      body,
      timeoutMs: sendTimeoutMs,
      operationId: operationId ?? toDeviceId,
    }, signal);
    if (!response.ok || !response.data) {
      const payloadError =
        response.data && typeof response.data.error === "string" && response.data.error.trim()
          ? response.data.error
          : null;
      const statusHint = response.status > 0 ? ` (status ${response.status})` : "";
      return {
        ok: false,
        error: payloadError ?? response.error ?? `Send failed${statusHint}`,
      };
    }
    return response.data;
  }

  async poll(after: string | null, limit?: number): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set("deviceId", this.deviceId);
    if (after) params.set("after", after);
    if (limit) params.set("limit", String(limit));
    const response = await this.requestJson<PollResponse>(
      `/onion/inbox?${params}`,
      { method: "GET" }
    );
    if (!response.ok || !response.data) {
      return {
        ok: false,
        items: [],
        nextAfter: after,
        error: response.error ?? "Poll failed",
      };
    }
    return response.data;
  }

  private async pollInternal(
    after: string | null,
    limit: number,
    signal?: AbortSignal
  ): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set("deviceId", this.deviceId);
    if (after) params.set("after", after);
    if (limit) params.set("limit", String(limit));
    const response = await this.requestJson<PollResponse>(
      `/onion/inbox?${params}`,
      { method: "GET" },
      signal
    );
    if (!response.ok || !response.data) {
      return {
        ok: false,
        items: [],
        nextAfter: after,
        error: response.error ?? "Poll failed",
      };
    }
    return response.data;
  }

  startPolling(
    handlers: PollerHandlers,
    options?: { after?: string | null; limit?: number }
  ): PollerHandle {
    const baseDelayMs = 1000;
    const maxDelayMs = 8000;
    let cursor = options?.after ?? null;
    let failureCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    let aborter: AbortController | null = null;

    const jitterDelay = (value: number) => value + Math.floor(Math.random() * 251);

    const schedule = (delayMs: number) => {
      if (!active) return;
      timer = setTimeout(() => void tick(), jitterDelay(delayMs));
    };

    const tick = async () => {
      if (!active) return;
      aborter = new AbortController();
      try {
        const result = await this.pollInternal(cursor, options?.limit ?? 50, aborter.signal);
        if (!active || aborter.signal.aborted) return;
        if (result.ok) {
          if (failureCount > 0) {
            failureCount = 0;
          }
          cursor = result.nextAfter;
          handlers.onResult(result);
          schedule(baseDelayMs);
          return;
        }
        failureCount += 1;
        handlers.onError(result.error ?? "Poll failed");
      } catch (error) {
        if (!active || aborter.signal.aborted) return;
        failureCount += 1;
        handlers.onError(safeError(error));
      }
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, failureCount));
      schedule(backoffMs);
    };

    schedule(baseDelayMs);

    return {
      stop: () => {
        active = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (aborter) {
          aborter.abort();
          aborter = null;
        }
      },
    };
  }

  async address(): Promise<AddressResponse> {
    const response = await this.requestJson<AddressResponse>("/onion/address", {
      method: "GET",
    });
    if (!response.ok || !response.data) {
      return {
        ok: false,
        details: response.error ?? "Address check failed",
      };
    }
    return response.data;
  }
}
