import type { PeerHint, Transport, TransportKind, TransportStatus } from "./transport";
import { createOnionTransport } from "./onionTransport";
import { createDirectTransport } from "./directTransport";
import { redactIPs } from "./privacy";
import { decideConversationTransport } from "./transportPolicy";
import { useNetConfigStore } from "./netConfigStore";
import {
  dropExpiredOutboxByConv,
  enqueueOutbox,
  listDueOutboxByConv,
  markOutboxRetry,
  removeOutbox,
} from "../db/repo";

export type ConversationTransportStatus = TransportStatus & {
  kind?: TransportKind;
  warning?: boolean;
};

type StatusListener = (convId: string, status: ConversationTransportStatus) => void;
type MessageHandler = (bytes: Uint8Array) => void;

type RateLimitState = {
  windowStartMs: number;
  count: number;
};

type ConversationState = {
  transport: Transport | null;
  status: ConversationTransportStatus;
  connectPromise: Promise<void> | null;
  backoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  backoffResetTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
  peerHint?: PeerHint;
  messageHandlers: Map<MessageHandler, MessageHandler>;
  messageUnsubs: Array<() => void>;
  rateLimit: RateLimitState;
};

const states = new Map<string, ConversationState>();
const listeners = new Set<StatusListener>();
let directApprovalHandler: ((convId: string) => Promise<boolean>) | null = null;

const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_RESET_MS = 10_000;
const MAX_FRAME_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 1000;
const MAX_MESSAGES_PER_WINDOW = 20;
const DEFAULT_SEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_FLUSH_BATCH = 10;
const outboxFlushes = new Map<string, Promise<void>>();

const notify = (convId: string, status: ConversationTransportStatus) => {
  listeners.forEach((listener) => listener(convId, status));
};

const getState = (convId: string) => {
  let state = states.get(convId);
  if (!state) {
    state = {
      transport: null,
      status: { state: "idle" },
      connectPromise: null,
      backoffMs: DEFAULT_BACKOFF_MS,
      retryTimer: null,
      backoffResetTimer: null,
      active: false,
      messageHandlers: new Map(),
      messageUnsubs: [],
      rateLimit: { windowStartMs: 0, count: 0 },
    };
    states.set(convId, state);
  }
  return state;
};

const setStatus = (convId: string, status: ConversationTransportStatus) => {
  const state = getState(convId);
  const sanitized =
    status.detail && typeof status.detail === "string"
      ? { ...status, detail: redactIPs(status.detail) }
      : status;
  state.status = sanitized;
  notify(convId, sanitized);
};

const clearRetryTimer = (state: ConversationState) => {
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
};

const clearBackoffResetTimer = (state: ConversationState) => {
  if (state.backoffResetTimer !== null) {
    clearTimeout(state.backoffResetTimer);
    state.backoffResetTimer = null;
  }
};

const scheduleBackoffReset = (convId: string) => {
  const state = getState(convId);
  clearBackoffResetTimer(state);
  state.backoffResetTimer = setTimeout(() => {
    const current = getState(convId);
    if (current.status.state === "connected" && current.active) {
      current.backoffMs = DEFAULT_BACKOFF_MS;
    }
  }, BACKOFF_RESET_MS);
};

const shouldProcessIncoming = (convId: string, bytes: Uint8Array) => {
  const size = bytes?.byteLength ?? 0;
  const state = getState(convId);
  const mode = state.transport?.kind ?? "unknown";
  if (size > MAX_FRAME_BYTES) {
    console.warn(
      `[net] drop frame too large: size=${size} max=${MAX_FRAME_BYTES} mode=${mode} convId=${convId}`
    );
    return false;
  }

  const now = Date.now();
  if (now - state.rateLimit.windowStartMs >= RATE_WINDOW_MS) {
    state.rateLimit.windowStartMs = now;
    state.rateLimit.count = 0;
  }
  state.rateLimit.count += 1;
  if (state.rateLimit.count > MAX_MESSAGES_PER_WINDOW) {
    console.warn(`[transport] dropped frame: rate limit exceeded`, { convId });
    return false;
  }

  return true;
};

const scheduleRetry = (convId: string) => {
  const state = getState(convId);
  if (!state.active) return;
  clearRetryTimer(state);
  clearBackoffResetTimer(state);
  state.retryTimer = globalThis.setTimeout(() => {
    void connectConversation(convId, state.peerHint);
  }, state.backoffMs);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
};

const createOutboxId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `outbox-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const toErrorDetail = (error: unknown) => (error instanceof Error ? error.message : String(error));

const queueConversationOutbox = async (
  convId: string,
  payload: Uint8Array,
  lastError?: string
) => {
  const now = Date.now();
  try {
    await enqueueOutbox(
      {
        id: createOutboxId(),
        convId,
        createdAt: now,
        ttlMs: DEFAULT_SEND_TTL_MS,
        attempt: 0,
        nextAttemptAt: now,
        lastError,
      },
      payload
    );
  } catch (error) {
    const detail = toErrorDetail(error);
    if (detail.includes("Vault is locked")) {
      throw new Error(`Outbox enqueue failed: Vault is locked (${detail})`);
    }
    throw new Error(`Outbox enqueue failed: ${detail}`);
  }
};

const flushConversationOutbox = (convId: string, transport: Transport) => {
  const inFlight = outboxFlushes.get(convId);
  if (inFlight) return inFlight;
  const flushPromise = (async () => {
    const now = Date.now();
    await dropExpiredOutboxByConv(convId, now);
    const due = await listDueOutboxByConv(convId, now, OUTBOX_FLUSH_BATCH);
    let shouldReconnect = false;
    for (const item of due) {
      try {
        await transport.send(item.payload);
        await removeOutbox(item.meta.id);
      } catch (error) {
        shouldReconnect = true;
        const detail = toErrorDetail(error);
        await markOutboxRetry(item.meta.id, detail);
      }
    }
    if (shouldReconnect) {
      scheduleRetry(convId);
    }
  })()
    .catch((error) => {
      console.warn("[transport] outbox flush failed", { convId, error: toErrorDetail(error) });
    })
    .finally(() => {
      outboxFlushes.delete(convId);
    });
  outboxFlushes.set(convId, flushPromise);
  return flushPromise;
};

const connectTransport = async (transport: Transport, peerHint?: PeerHint) => {
  await transport.connect(peerHint);
};

const closeTransport = async (transport: Transport | null) => {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    // ignore close errors
  }
};

const attachHandlers = (state: ConversationState, transport: Transport) => {
  state.messageUnsubs.forEach((unsub) => unsub());
  state.messageUnsubs = [];
  for (const handler of state.messageHandlers.values()) {
    state.messageUnsubs.push(transport.onMessage(handler));
  }
};

export const setDirectApprovalHandler = (
  handler: ((convId: string) => Promise<boolean>) | null
) => {
  directApprovalHandler = handler;
};

export const onTransportStatusChange = (listener: StatusListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getTransportStatus = (convId: string) => getState(convId).status;

export const connectConversation = async (convId: string, peerHint?: PeerHint) => {
  const state = getState(convId);
  state.active = true;
  state.peerHint = peerHint;

  if (state.connectPromise) return state.connectPromise;
  clearRetryTimer(state);
  clearBackoffResetTimer(state);

  const connectAttempt = (async () => {
    setStatus(convId, { state: "connecting" });

    await closeTransport(state.transport);
    state.transport = null;

    const config = useNetConfigStore.getState().config;
    const isDeviceSyncPeer = peerHint?.kind === "device";
    let directApproved = true;
    if (!isDeviceSyncPeer && directApprovalHandler) {
      try {
        directApproved = await directApprovalHandler(convId);
      } catch {
        directApproved = false;
      }
    }
    const deviceSyncPolicy = isDeviceSyncPeer
      ? peerHint?.deviceSyncTransportPolicy ?? "directOnly"
      : undefined;
    const allowDirect = isDeviceSyncPeer
      ? deviceSyncPolicy === "directOnly"
        ? true
        : config.mode === "directP2P"
      : config.mode === "directP2P" && directApproved;
    const decision = decideConversationTransport({
      allowDirect,
      directOnly: isDeviceSyncPeer && deviceSyncPolicy === "directOnly",
    });
    const primary = decision.primary;

    const tryKind = async (kind: TransportKind) => {
      const transport = kind === "direct" ? createDirectTransport() : createOnionTransport();
      try {
        await connectTransport(transport, peerHint);
        state.transport = transport;
        attachHandlers(state, transport);
        setStatus(convId, { state: "connected", kind, warning: kind === "direct" });
        scheduleBackoffReset(convId);
        void flushConversationOutbox(convId, transport);
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(convId, { state: "failed", kind, detail });
        return false;
      }
    };

    const primaryConnected = await tryKind(primary);
    if (primaryConnected) return;
    if (!decision.fallback || decision.fallback === primary) {
      scheduleRetry(convId);
      return;
    }
    const fallbackConnected = await tryKind(decision.fallback);
    if (!fallbackConnected) {
      scheduleRetry(convId);
    }
  })()
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(convId, { state: "failed", detail });
      scheduleRetry(convId);
    })
    .finally(() => {
      const finalState = getState(convId);
      finalState.connectPromise = null;
    });

  state.connectPromise = connectAttempt;
  return connectAttempt;
};

export const disconnectConversation = async (convId: string) => {
  const state = getState(convId);
  state.active = false;
  clearRetryTimer(state);
  clearBackoffResetTimer(state);
  state.rateLimit = { windowStartMs: 0, count: 0 };
  await closeTransport(state.transport);
  state.transport = null;
  state.connectPromise = null;
  state.backoffMs = DEFAULT_BACKOFF_MS;
  state.messageUnsubs.forEach((unsub) => unsub());
  state.messageUnsubs = [];
  setStatus(convId, { state: "idle" });
};

export const sendToConversation = async (convId: string, payload: Uint8Array) => {
  const state = getState(convId);
  if (!state.transport || state.status.state !== "connected") {
    await queueConversationOutbox(convId, payload);
    void connectConversation(convId, state.peerHint);
    return;
  }
  try {
    await state.transport.send(payload);
  } catch (error) {
    const detail = toErrorDetail(error);
    await queueConversationOutbox(convId, payload, detail);
    scheduleRetry(convId);
    return;
  }
};

export const onConversationMessage = (
  convId: string,
  handler: (bytes: Uint8Array) => void
) => {
  const state = getState(convId);
  if (state.messageHandlers.has(handler)) {
    return () => {
      state.messageHandlers.delete(handler);
    };
  }
  const wrapped = (bytes: Uint8Array) => {
    if (!shouldProcessIncoming(convId, bytes)) return;
    handler(bytes);
  };
  state.messageHandlers.set(handler, wrapped);
  let unsub: (() => void) | null = null;
  if (state.transport) {
    unsub = state.transport.onMessage(wrapped);
    state.messageUnsubs.push(unsub);
  }
  return () => {
    state.messageHandlers.delete(handler);
    if (unsub) {
      unsub();
      state.messageUnsubs = state.messageUnsubs.filter((item) => item !== unsub);
    }
  };
};
