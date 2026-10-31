import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { createTransportError, getTransportErrorCode } from "./transportErrors";
import { createId } from "../utils/ids";
import { decodeBase64, encodeBase64 } from "../security/base64url";

import type { MainAccountSession } from "../accounts/mainSessionTypes";
import type { LocalReceiveOwner } from "../accounts/receiveContext";

export type OnionInboxConfig = {
  receiveSession?: MainAccountSession;
  baseUrl: string;
  deviceId: string;
  mailboxToken?: string;
  timeoutMs?: number;
};

type PollerHandlers = {
  /** Local application dispatcher priority; absent means observation only. */
  authority?: number;
  onResult: (result: PollResponse) => Promise<boolean | string[]> | boolean | string[] | void;
  onError: (error: string) => void;
};

type PollerHandle = {
  stop: () => void;
};

type HealthResponse = {
  ok: boolean;
  network: "tor" | "none";
  details?: string;
  tor?: {
    active: boolean;
    socksProxy?: string | null;
    address?: string;
    details?: string;
  };
};

type SendResponse = {
  ok: boolean;
  msgId?: string;
  error?: string;
  forwarded?: boolean;
  queued?: boolean;
  status?: string;
};

type AddressResponse = {
  ok: boolean;
  torOnion?: string;
  details?: string;
};

export type PollResponse = {
  ok: boolean;
  items: Array<{ id: string; ts: number; from: string; envelope: string | Uint8Array; localOwner?: LocalReceiveOwner }>;
  nextAfter: string | null;
  error?: string;
};

type ControllerFetchRequest = {
  receiveSession?: MainAccountSession;
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  bodyPayload?: import("../main/onionController").OnionSendPayload;
  binaryInbox?: boolean;
  timeoutMs?: number;
};

type ControllerFetchResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyPayload?: PollResponse;
  error?: string;
};

const safeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "Unknown error");

const DEFAULT_TIMEOUT_MS = 10_000;

const SEND_TIMEOUT_MS = 60_000;

const POLL_BASE_DELAY_MS = 250;

const POLL_MAX_DELAY_MS = 8000;

const POLL_JITTER_MS = 100;

const sharedInFlightRequests = new Map<string, Promise<unknown>>();

type SharedPollerState = {
  subscribers: Set<PollerHandlers>;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  aborter: AbortController | null;
  cursor: string | null;
  failureCount: number;
  retained: Map<string, { attempts: number; nextAt: number }>;
  limit: number;
  tick: () => Promise<void>;
  schedule: (delayMs: number) => void;
};

const sharedPollers = new Map<string, SharedPollerState>();

const isInboxPollOperation = (opId: string) => opId.startsWith("/onion/inbox?");

const getNkcControllerFetch = () =>
  (
    globalThis as {
      nkc?: {
        onionControllerFetch?: (req: ControllerFetchRequest) => Promise<ControllerFetchResponse>;
      };
    }
  ).nkc?.onionControllerFetch;

export class OnionInboxClient {
  private readonly receiveSession?: MainAccountSession;
  private readonly baseUrl: string;
  private readonly deviceId: string;
  private readonly mailboxToken?: string;
  private readonly timeoutMs: number;

  constructor(cfg: OnionInboxConfig) {
    this.receiveSession = cfg.receiveSession;
    this.baseUrl = cfg.baseUrl;
    this.deviceId = cfg.deviceId;
    this.mailboxToken = cfg.mailboxToken;
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

        return `inbox:${deviceId}:${parsed.searchParams.has("binary") ? parsed.search : "legacy"}`;
      } catch {
        return `inbox:${this.deviceId}`;
      }
    }

    return null;
  }

  private toSharedRequestKey(path: string) {
    const key = this.toCoalesceKey(path);

    if (!key) return null;

    return `${this.baseUrl}|${key}|${this.receiveSession?.token ?? "diagnostic"}`;
  }

  private toPollerKey() {
    return `${this.baseUrl}|inbox:${this.deviceId}|${this.receiveSession?.token ?? "diagnostic"}`;
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
    init: {
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
      operationId?: string;
    },
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const coalesceKey = this.toSharedRequestKey(path);

    if (!coalesceKey) {
      return this.requestJsonUncoalesced<T>(path, init, signal);
    }

    const existing = sharedInFlightRequests.get(coalesceKey);

    if (existing) {
      return (await existing) as { ok: boolean; status: number; data?: T; error?: string };
    }

    const requestPromise = this.requestJsonUncoalesced<T>(path, init, signal);
    sharedInFlightRequests.set(coalesceKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      const current = sharedInFlightRequests.get(coalesceKey);

      if (current === requestPromise) {
        sharedInFlightRequests.delete(coalesceKey);
      }
    }
  }

  private async requestJsonUncoalesced<T>(
    path: string,
    init: {
      method: string;
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
      operationId?: string;
    },
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const requestUrl = new URL(path, this.baseUrl);
    const url = requestUrl.toString();
    const binaryInbox = path.startsWith("/onion/inbox?") && requestUrl.searchParams.get("binary") === "nkcp-v2";

    const bodyPayload = init.body && typeof init.body === "object" && "envelope" in init.body && init.body.envelope instanceof Uint8Array
      ? { ...init.body, envelope: init.body.envelope } : undefined;

    const body = init.body !== undefined && !bodyPayload ? JSON.stringify(init.body) : undefined;

    const headers = {
      "Content-Type": "application/json",
      ...init.headers,
    };

    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const operationId = init.operationId ?? path;

    const controllerFetch = getNkcControllerFetch();

    if (controllerFetch) {
      const abortId = `abort:${createId()}`;

      if (!isInboxPollOperation(operationId)) {
        emitFlowTraceLog({
          event: "abort:linked",
          abortId,
          opId: operationId,
          source: "controller-fetch",
        });
      }

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
          receiveSession: this.receiveSession,
          url,
          method: init.method,
          headers,
          bodyPayload,
          binaryInbox: binaryInbox || undefined,
          bodyBase64: body ? encodeBase64(new TextEncoder().encode(body)) : undefined,
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
          ? new TextDecoder().decode(decodeBase64(response.bodyBase64))
          : "";

        const parsed = (response.bodyPayload ?? (decoded ? JSON.parse(decoded) : undefined)) as T | undefined;

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

    if (bodyPayload || binaryInbox) return { ok: false, status: 0, error: "binary-controller-ipc-required" };

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
            if (trace.event === "abort:linked" && isInboxPollOperation(trace.opId)) {
              return;
            }

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
    envelope: string | Uint8Array,
    ttlMs?: number,
    route?: {
      mode: "auto" | "preferTor" | "manual";
      torOnion?: string;
      inboxWriteToken?: string;
    },
    signal?: AbortSignal,
    operationId?: string
  ): Promise<SendResponse> {
    const body = {
      to: route ? undefined : toDeviceId,
      toDeviceId,
      fromDeviceId: this.deviceId,
      envelope,
      ttlMs,
      route,
    };

    const sendTimeoutMs = Math.max(this.timeoutMs, SEND_TIMEOUT_MS);

    const response = await this.requestJson<SendResponse>("/onion/send", {
      method: "POST",
      body,
      timeoutMs: sendTimeoutMs,
      operationId: operationId ?? "onion-send",
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

  async pollBinary(scanAfter: string | null, limit = 50): Promise<PollResponse> {
    const params = new URLSearchParams({ deviceId: this.deviceId, scanAfter: scanAfter ?? "-1", limit: String(limit), binary: "nkcp-v2" });

    const response = await this.requestJson<PollResponse>(`/onion/inbox?${params}`, {
      method: "GET", headers: this.mailboxToken ? { "X-NKC-Mailbox-Token": this.mailboxToken } : undefined,
    });

    return response.data ?? { ok: false, items: [], nextAfter: scanAfter, error: response.error ?? "Poll failed" };
  }

  async poll(after: string | null, limit?: number): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set("deviceId", this.deviceId);

    if (after) params.set("after", after);

    if (limit) params.set("limit", String(limit));

    const response = await this.requestJson<PollResponse>(
      `/onion/inbox?${params}`,
      {
        method: "GET",
        headers: this.mailboxToken
          ? { "X-NKC-Mailbox-Token": this.mailboxToken }
          : undefined,
      }
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
    signal?: AbortSignal,
    scanOnly = false
  ): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set("deviceId", this.deviceId);

    if (scanOnly) {
      params.set("scanAfter", after ?? "-1");

      if (this.receiveSession && getNkcControllerFetch()) params.set("binary", "nkcp-v2");
    }
    else if (after) params.set("after", after);

    if (limit) params.set("limit", String(limit));

    const response = await this.requestJson<PollResponse>(
      `/onion/inbox?${params}`,
      {
        method: "GET",
        headers: this.mailboxToken
          ? { "X-NKC-Mailbox-Token": this.mailboxToken }
          : undefined,
      },
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
    const pollerKey = this.toPollerKey();
    const desiredLimit = options?.limit ?? 50;
    const desiredCursor = options?.after ?? null;
    const existing = sharedPollers.get(pollerKey);

    if (existing) {
      existing.subscribers.add(handlers);

      if (desiredCursor && !existing.cursor) {
        existing.cursor = desiredCursor;
      }

      if (desiredLimit > existing.limit) {
        existing.limit = desiredLimit;
      }

      return {
        stop: () => {
          existing.subscribers.delete(handlers);

          if (existing.subscribers.size > 0) return;
          existing.active = false;

          if (existing.timer) {
            clearTimeout(existing.timer);
            existing.timer = null;
          }

          if (existing.aborter) {
            existing.aborter.abort();
            existing.aborter = null;
          }

          sharedPollers.delete(pollerKey);
        },
      };
    }

    const state: SharedPollerState = {
      subscribers: new Set([handlers]),
      active: true,
      timer: null,
      aborter: null,
      cursor: desiredCursor,
      failureCount: 0,
      retained: new Map(),
      limit: desiredLimit,
      tick: async () => {},
      schedule: () => {},
    };

    sharedPollers.set(pollerKey, state);

    const jitterDelay = (value: number) => value + Math.floor(Math.random() * (POLL_JITTER_MS + 1));

    state.schedule = (delayMs: number) => {
      if (!state.active) return;
      state.timer = setTimeout(() => void state.tick(), jitterDelay(delayMs));
    };

    state.tick = async () => {
      if (!state.active || state.subscribers.size === 0) return;
      state.aborter = new AbortController();

      try {
        const acknowledger = typeof window === "undefined" ? undefined : window.nkc?.acknowledgeOnionInboxItems;
        const itemAcknowledgement = Boolean(acknowledger && this.receiveSession);
        const result = await this.pollInternal(state.cursor, state.limit, state.aborter.signal, itemAcknowledgement);

        if (!state.active || state.aborter.signal.aborted) return;

        if (result.ok) {
          if (state.failureCount > 0) {
            state.failureCount = 0;
          }

          const subscribers = Array.from(state.subscribers);
          const applications = subscribers.filter(subscriber => Number.isFinite(subscriber.authority));
          const priority = Math.max(...applications.map(subscriber => subscriber.authority!));
          const selected = applications.filter(subscriber => subscriber.authority === priority);

          // One application dispatcher returns completed IDs. Failed/deferred IDs stay in the same inbox.
          if (selected.length === 1) {
            // Only non-destructive, per-item ACK polling may skip deferred work.
            const items = itemAcknowledgement ? result.items.filter(item =>
              (state.retained.get(item.id)?.nextAt ?? 0) <= performance.now()) : result.items;
            const completion = !itemAcknowledgement || items.length ? await selected[0].onResult({ ...result, items }) : [];

            if (state.active && itemAcknowledgement && Array.isArray(completion)) {
              const available = new Set(items.map(item => item.id));

              if (completion.some(id => !available.has(id))) throw new Error("INBOX_COMPLETION_MISMATCH");
              for (const item of items) {
                if (completion.includes(item.id)) { state.retained.delete(item.id); continue; }
                const attempts = Math.min((state.retained.get(item.id)?.attempts ?? 0) + 1, 4);
                state.retained.delete(item.id);
                state.retained.set(item.id, { attempts, nextAt: performance.now() + Math.min(POLL_MAX_DELAY_MS, 1000 * 2 ** (attempts - 1)) });
                if (state.retained.size > 2048) state.retained.delete(state.retained.keys().next().value!);
              }

              if (completion.length && !await acknowledger!(this.receiveSession!, this.deviceId, [...new Set(completion)])) {
                throw new Error("INBOX_ACK_REJECTED");
              }
            } else if (state.active && (completion === true || Array.isArray(completion) &&
                result.items.every(item => completion.includes(item.id)))) {
              state.cursor = result.nextAfter;
            }
          }

          if (itemAcknowledgement) state.cursor = result.items.length ? result.nextAfter : null;

          for (const observer of subscribers.filter(subscriber => subscriber.authority === undefined)) {
            void Promise.resolve().then(() => observer.onResult(result)).catch(() => {});
          }

          state.schedule(POLL_BASE_DELAY_MS);

          return;
        }

        state.failureCount += 1;
        state.subscribers.forEach((subscriber) =>
          subscriber.onError(result.error ?? "Poll failed")
        );
      } catch (error) {
        if (!state.active || state.aborter.signal.aborted) return;
        state.failureCount += 1;
        state.subscribers.forEach((subscriber) => subscriber.onError(safeError(error)));
      }

      const backoffMs = Math.min(POLL_MAX_DELAY_MS, POLL_BASE_DELAY_MS * Math.pow(2, state.failureCount));
      state.schedule(backoffMs);
    };

    // Poll immediately so pending friend requests do not wait for the first interval.
    state.schedule(0);

    return {
      stop: () => {
        state.subscribers.delete(handlers);

        if (state.subscribers.size > 0) return;
        state.active = false;

        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }

        if (state.aborter) {
          state.aborter.abort();
          state.aborter = null;
        }

        sharedPollers.delete(pollerKey);
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
