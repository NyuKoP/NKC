import type { HttpClient } from "../../net/httpClient";
import type { NetConfig } from "../../net/netConfig";
import { OnionInboxClient } from "../../net/onionInboxClient";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { getOnionControllerUrlOverride, getRoutePolicy } from "../../security/preferences";
import type { RouteMode } from "../../main/routePolicy";
import type { Transport, TransportPacket, TransportState } from "./types";

type Handler<T> = (payload: T) => void;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEEN_IDS = 500;
const STATE_DEBOUNCE_MS = 1000;

type OnionFetchRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
};

type OnionFetchResponse = {
  ok: boolean;
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

export async function onionFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const nkc = (
    globalThis as { nkc?: { onionFetch?: (req: OnionFetchRequest) => Promise<OnionFetchResponse> } }
  ).nkc;
  if (!nkc?.onionFetch) {
    throw new Error("Onion fetch unavailable");
  }
  const headers = new Headers(init.headers ?? {});
  let bodyBase64: string | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      bodyBase64 = toBase64(new TextEncoder().encode(init.body));
    } else if (init.body instanceof Uint8Array) {
      bodyBase64 = toBase64(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      bodyBase64 = toBase64(new Uint8Array(init.body));
    } else {
      throw new Error("Unsupported onion fetch body");
    }
  }
  const response = await nkc.onionFetch({
    url,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    bodyBase64,
    timeoutMs: init.timeoutMs,
  });
  const body = response.bodyBase64 ? fromBase64(response.bodyBase64) : new Uint8Array();
  const respHeaders = new Headers(response.headers ?? {});
  return new Response(body, { status: response.status, headers: respHeaders });
}

type OnionRouterOptions = {
  httpClient: HttpClient;
  config: NetConfig;
};

export const createOnionRouterTransport = ({
  httpClient,
  config,
}: OnionRouterOptions): Transport => {
  let state: TransportState = "idle";
  let client: OnionInboxClient | null = null;
  let pollerStop: (() => void) | null = null;
  let errorStreak = 0;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  const requestState = (next: TransportState, immediate = false) => {
    if (state === next) return;
    const flipFlop =
      (state === "connected" && next === "degraded") ||
      (state === "degraded" && next === "connected");
    if (!immediate && flipFlop) {
      if (stateTimer) clearTimeout(stateTimer);
      stateTimer = setTimeout(() => {
        stateTimer = null;
        emitState(next);
      }, STATE_DEBOUNCE_MS);
      return;
    }
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    emitState(next);
  };

  const rememberId = (id: string) => {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > MAX_SEEN_IDS) {
      const overflow = seenOrder.splice(0, seenOrder.length - MAX_SEEN_IDS);
      overflow.forEach((oldId) => seenIds.delete(oldId));
    }
    return true;
  };

  const updateStateForError = () => {
    if (errorStreak >= 6) {
      requestState("failed", true);
    } else if (errorStreak >= 3) {
      requestState("degraded");
    }
  };

  const decodeEnvelope = (envelope: string): TransportPacket | null => {
    try {
      const json = new TextDecoder().decode(decodeBase64Url(envelope));
      const parsed = JSON.parse(json) as TransportPacket;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const resolveControllerUrl = async () => {
    const nkc = (
      globalThis as { nkc?: { getOnionControllerUrl?: () => Promise<string> } }
    ).nkc;
    let localUrl = "";
    if (nkc?.getOnionControllerUrl) {
      try {
        localUrl = await nkc.getOnionControllerUrl();
      } catch {
        localUrl = "";
      }
    }
    const override = (await getOnionControllerUrlOverride()).trim();
    if (override) return override;
    if (localUrl) return localUrl;
    return "http://127.0.0.1:3210";
  };

  const handlePollSuccess = (result: Awaited<ReturnType<OnionInboxClient["poll"]>>) => {
    errorStreak = 0;
    if (state === "degraded" || state === "failed") {
      requestState("connected");
    }
    result.items.forEach((item) => {
      if (!rememberId(item.id)) return;
      const packet = decodeEnvelope(item.envelope);
      if (!packet) return;
      messageHandlers.forEach((handler) => handler(packet));
    });
  };

  const handlePollError = () => {
    errorStreak += 1;
    updateStateForError();
  };

  return {
    name: "onionRouter",
    async start() {
      void httpClient;
      void config;
      requestState("connecting", true);
      const baseUrl = await resolveControllerUrl();
      client = new OnionInboxClient({
        baseUrl,
        deviceId: getOrCreateDeviceId(),
      });
      const health = await client.health();
      if (!health.ok) {
        requestState("failed", true);
        throw new Error(health.details ?? "Onion controller unavailable");
      }
      requestState("connected", true);
      pollerStop = client.startPolling(
        {
          onResult: handlePollSuccess,
          onError: handlePollError,
        },
        { limit: 50 }
      ).stop;
    },
    async stop() {
      if (pollerStop) {
        pollerStop();
        pollerStop = null;
      }
      if (stateTimer) {
        clearTimeout(stateTimer);
        stateTimer = null;
      }
      errorStreak = 0;
      seenIds.clear();
      seenOrder.length = 0;
      client = null;
      requestState("idle", true);
    },
    async send(packet: TransportPacket) {
      const torOnion =
        (packet as { torOnion?: string }).torOnion ??
        (packet as { toOnion?: string }).toOnion ??
        (packet as { route?: { torOnion?: string; toOnion?: string } }).route?.torOnion ??
        (packet as { route?: { torOnion?: string; toOnion?: string } }).route?.toOnion ??
        (packet as { meta?: { torOnion?: string; toOnion?: string } }).meta?.torOnion ??
        (packet as { meta?: { torOnion?: string; toOnion?: string } }).meta?.toOnion;
      const lokinet =
        (packet as { lokinet?: string }).lokinet ??
        (packet as { route?: { lokinet?: string } }).route?.lokinet ??
        (packet as { meta?: { lokinet?: string } }).meta?.lokinet;
      const routeMode =
        ((packet as { route?: { mode?: RouteMode } }).route?.mode ??
          (packet as { meta?: { routeMode?: RouteMode } }).meta?.routeMode ??
          (packet as { meta?: { routePolicy?: RouteMode } }).meta?.routePolicy) ??
        ((await getRoutePolicy()) as RouteMode);
      const toDeviceId =
        (packet as { toDeviceId?: string }).toDeviceId ??
        (packet as { meta?: { toDeviceId?: string } }).meta?.toDeviceId ??
        (packet as { route?: { toDeviceId?: string } }).route?.toDeviceId ??
        (packet as { to?: string }).to ??
        (packet as { route?: { to?: string } }).route?.to ??
        (packet as { meta?: { to?: string } }).meta?.to;
      if (!toDeviceId) {
        console.warn("[onion] missing toDeviceId for outbound packet", {
          id: (packet as { id?: string }).id,
        });
        throw new Error("onionRouterTransport: missing destination 'to'");
      }
      if (!client) {
        throw new Error("Onion controller is not ready");
      }
      const envelope = encodeBase64Url(
        new TextEncoder().encode(JSON.stringify(packet))
      );
      const route =
        torOnion || lokinet
          ? {
              mode: routeMode,
              torOnion,
              lokinet,
            }
          : undefined;
      const result = await client.send(toDeviceId, envelope, DEFAULT_TTL_MS, route);
      if (!result.ok) {
        throw new Error(result.error ?? "Onion send failed");
      }
      ackHandlers.forEach((handler) => handler({ id: packet.id, rttMs: 0 }));
    },
    onMessage(cb) {
      messageHandlers.push(cb);
    },
    onAck(cb) {
      ackHandlers.push((payload) => cb(payload.id, payload.rttMs));
    },
    onState(cb) {
      stateHandlers.push(cb);
      cb(state);
    },
  };
};
