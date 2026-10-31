import { createId } from "../utils/ids";
import { createTransportError } from "./transportErrors";

export type AbortTraceEvent = {
  event: "abort:linked" | "abort:fired";
  abortId: string;
  opId: string;
  source: string;
  reason?: string;
};

export type FetchWithTimeoutOptions<TResponse = Response> = {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  opId?: string;
  traceSource?: string;
  onTrace?: (event: AbortTraceEvent) => void;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<TResponse>;
};

const toSafeOperationId = (url: string, explicit?: string) => {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  try {
    const parsed = new URL(url);
    const safePath = parsed.pathname || "/";
    const deviceId = parsed.searchParams.get("deviceId");

    return deviceId ? `${safePath}?deviceId=${deviceId}` : safePath;
  } catch {
    return url;
  }
};

export function fetchWithTimeout<TResponse>(
  url: string,
  init: RequestInit,
  options: FetchWithTimeoutOptions<TResponse> & {
    fetchImpl: (url: string, init?: RequestInit) => Promise<TResponse>;
  }
): Promise<TResponse>;

export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: FetchWithTimeoutOptions
): Promise<Response>;

export async function fetchWithTimeout<TResponse>(
  url: string,
  init: RequestInit = {},
  options: FetchWithTimeoutOptions<TResponse>
): Promise<Response | TResponse> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs);
  const source = options.traceSource ?? "timeout";
  const opId = toSafeOperationId(url, options.opId);
  const abortId = `abort:${createId()}`;
  let abortReason: "timeout" | "parent" | null = null;

  const emitTrace = (event: AbortTraceEvent["event"], reason?: string) => {
    if (!options.onTrace) return;
    options.onTrace({
      event,
      abortId,
      opId,
      source,
      reason,
    });
  };

  emitTrace("abort:linked");

  const fireAbort = (reason: "timeout" | "parent") => {
    if (abortReason) return;
    abortReason = reason;

    const detail =
      reason === "timeout"
        ? `fetch timeout ${timeoutMs}ms`
        : "aborted-by-parent-signal";

    emitTrace("abort:fired", detail);
    controller.abort(detail);
  };

  let onParentAbort: (() => void) | null = null;

  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      fireAbort("parent");
      throw createTransportError("ABORTED_PARENT", "fetch aborted by parent signal");
    }

    onParentAbort = () => fireAbort("parent");
    options.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    fireAbort("timeout");
  }, timeoutMs);

  try {
    const fetchImpl = options.fetchImpl ?? fetch;

    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (abortReason === "timeout") {
      throw createTransportError("ABORTED_TIMEOUT", `fetch timeout ${timeoutMs}ms`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (abortReason === "parent") {
      throw createTransportError("ABORTED_PARENT", "fetch aborted by parent signal", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);

    if (options.parentSignal && onParentAbort) {
      options.parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}
