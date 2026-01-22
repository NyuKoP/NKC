export type OnionInboxConfig = {
  baseUrl: string;
  deviceId: string;
  timeoutMs?: number;
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
    init: { method: string; body?: unknown }
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    const url = new URL(path, this.baseUrl).toString();
    const body =
      init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const timeoutMs = this.timeoutMs;

    const controllerFetch = getNkcControllerFetch();
    if (controllerFetch) {
      try {
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
    route?: { mode: "auto" | "preferLokinet" | "preferTor" | "manual"; torOnion?: string; lokinet?: string }
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
    });
    if (!response.ok || !response.data) {
      return {
        ok: false,
        error: response.error ?? "Send failed",
      };
    }
    return response.data;
  }

  async poll(after: string | null, limit?: number): Promise<PollResponse> {
    const params = new URLSearchParams();
    params.set("deviceId", this.deviceId);
    if (after) params.set("after", after);
    if (limit) params.set("limit", String(limit));
    const response = await this.requestJson<PollResponse>(`/onion/inbox?${params}`, {
      method: "GET",
    });
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
