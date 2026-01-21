import type { PeerHint, Transport, TransportKind, TransportStatus } from "./transport";
import { createOnionTransport } from "./onionTransport";
import { createDirectTransport } from "./directTransport";
import { getConvAllowDirect, setConvAllowDirect } from "../security/preferences";

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

let approvalHandler: ((convId: string) => Promise<boolean>) | null = null;

const states = new Map<string, ConversationState>();
const listeners = new Set<StatusListener>();

const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_RESET_MS = 10_000;
const MAX_FRAME_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 1000;
const MAX_MESSAGES_PER_WINDOW = 20;

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
  state.status = status;
  notify(convId, status);
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
  if (size > MAX_FRAME_BYTES) {
    console.warn(`[transport] dropped frame: ${size} bytes (limit ${MAX_FRAME_BYTES})`, { convId });
    return false;
  }

  const state = getState(convId);
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
  approvalHandler = handler;
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

    const onion = createOnionTransport();
    try {
      await connectTransport(onion, peerHint);
      state.transport = onion;
      attachHandlers(state, onion);
      setStatus(convId, { state: "connected", kind: "onion" });
      scheduleBackoffReset(convId);
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(convId, { state: "failed", kind: "onion", detail });
    }

    const allowDirect = await getConvAllowDirect(convId);
    let approved = allowDirect;
    if (!approved && approvalHandler) {
      approved = await approvalHandler(convId);
      if (approved) {
        await setConvAllowDirect(convId, true);
      }
    }

    if (!approved) {
      scheduleRetry(convId);
      return;
    }

    const direct = createDirectTransport();
    try {
      await connectTransport(direct, peerHint);
      state.transport = direct;
      attachHandlers(state, direct);
      setStatus(convId, { state: "connected", kind: "direct", warning: true });
      scheduleBackoffReset(convId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(convId, { state: "failed", kind: "direct", detail });
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
  if (!state.transport) {
    throw new Error("Transport not connected");
  }
  await state.transport.send(payload);
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
