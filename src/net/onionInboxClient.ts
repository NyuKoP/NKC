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

  constructor(cfg: OnionInboxConfig) {
    this.baseUrl = cfg.baseUrl;
    this.deviceId = cfg.deviceId;
    this.timeoutMs = cfg.timeoutMs ?? 10000;
  }

  private async requestJson<T>(
    path: string,
    init: { method: string; body?: unknown },
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const url = new URL(path, this.baseUrl).toString();
    const body =
      init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const timeoutMs = this.timeoutMs;

    const controllerFetch = getNkcControllerFetch();
    if (controllerFetch) {
      try {
        if (signal?.aborted) {
          return { ok: false, status: 0, error: "aborted" };
        }
        const response = await controllerFetch({
          url,
          method: init.method,
          headers,
          bodyBase64: body ? toBase64(new TextEncoder().encode(body)) : undefined,
          timeoutMs,
        });
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
        return { ok: false, status: 0, error: safeError(error) };
      }
    }

    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) {
        return { ok: false, status: 0, error: "aborted" };
      }
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as T) : undefined;
      return { ok: response.ok, status: response.status, data: parsed };
    } catch (error) {
      return { ok: false, status: 0, error: safeError(error) };
    } finally {
      clearTimeout(timeout);
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
    signal?: AbortSignal
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
    const response = await this.requestJson<SendResponse>("/onion/send", {
      method: "POST",
      body,
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
    const jitter = 0.15;
    let cursor = options?.after ?? null;
    let failureCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    let aborter: AbortController | null = null;

    const jitterDelay = (value: number) => {
      const offset = value * jitter * (Math.random() * 2 - 1);
      return Math.max(0, Math.round(value + offset));
    };

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
