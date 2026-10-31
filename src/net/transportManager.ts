import { countSessionStage } from "../diagnostics/sessionInvestigation";
import { onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { onVaultKeyChange } from "../crypto/sessionKeyring";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import type { VaultAccess } from "../db/vaultAccess";
import type { PeerHint, Transport, TransportKind, TransportStatus, MessageHandler } from "./transport";
import { createOnionTransport } from "./onionTransport";
import { createDirectTransport } from "./directTransport";
import { redactIPs } from "./privacy";
import { assertSupportedNetworkConfig, decideConversationTransport } from "./transportPolicy";
import { useNetConfigStore } from "./netConfigStore";
import {
  dropExpiredOutboxByConv,
  enqueueOutbox,
  listDueOutboxByConv,
  markOutboxRetry,
  removeOutbox,
} from "../db/repo";
import { createSafeConsole } from "../diagnostics/safeConsole";
import { createId } from "../utils/ids";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "./mediaTransferLimits";

const console = createSafeConsole(globalThis.console);

export type ConversationTransportStatus = TransportStatus & {
  kind?: TransportKind;
  warning?: boolean;
};

type StatusListener = (convId: string, status: ConversationTransportStatus) => void;

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

const MAX_FRAME_BYTES = ONION_TRANSFER_MAX_BODY_BYTES;

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
    const current = states.get(convId);

    if (current !== state) return;

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
    if (states.get(convId) === state) void connectConversation(convId, state.peerHint);
  }, state.backoffMs);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
};

const createOutboxId = createId;

const toErrorDetail = (error: unknown) => (error instanceof Error ? error.message : String(error));

const queueConversationOutbox = async (
  convId: string,
  payload: Uint8Array,
  lastError?: string, access?: VaultAccess
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
      payload, access
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
  const state = states.get(convId);
  const inFlight = outboxFlushes.get(convId);

  if (inFlight) return inFlight;

  const flushPromise = (async () => {
    const context = await captureLocalOperationContext();
    const access = context?.vault;

    if (states.get(convId) !== state) return;
    const now = Date.now();
    await dropExpiredOutboxByConv(convId, now, access);
    const due = await listDueOutboxByConv(convId, now, OUTBOX_FLUSH_BATCH, access);
    let shouldReconnect = false;

    for (const item of due) {
      try {
        access?.assertLocal();

        if (states.get(convId) !== state) return;
        await transport.send(item.payload);
        await removeOutbox(item.meta.id, access);
      } catch (error) {
        shouldReconnect = true;
        const detail = toErrorDetail(error);
        await markOutboxRetry(item.meta.id, detail, access);
      }
    }

    if (shouldReconnect && states.get(convId) === state) {
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
    countSessionStage("transport-close", "input");
    await closeTransport(state.transport);
    countSessionStage("transport-close", "success");
    state.transport = null;

    if (states.get(convId) !== state || !state.active) return;

    const config = useNetConfigStore.getState().config;
    assertSupportedNetworkConfig(config);
    const isDeviceSyncPeer = peerHint?.kind === "device";
    let directApproved = true;

    if (!isDeviceSyncPeer && directApprovalHandler) {
      try {
        countSessionStage("transport-approval", "input");
        directApproved = await directApprovalHandler(convId);
        countSessionStage("transport-approval", "success");
      } catch {
        directApproved = false;
      }
    }

    const deviceSyncPolicy = isDeviceSyncPeer
      ? peerHint?.deviceSyncTransportPolicy ?? "directOnly"
      : undefined;

    const rootAuthorizedDevice = peerHint?.deviceAuthorizationVersion === 2;

    const allowDirect = rootAuthorizedDevice ? false : isDeviceSyncPeer
      ? deviceSyncPolicy === "directOnly"
        ? true
        : config.mode === "directP2P"
      : config.mode === "directP2P" && directApproved;

    const decision = decideConversationTransport({
      allowDirect,
      directOnly: !rootAuthorizedDevice && isDeviceSyncPeer && deviceSyncPolicy === "directOnly",
    });

    const primary = decision.primary;

    const tryKind = async (kind: TransportKind) => {
      if (states.get(convId) !== state || !state.active) return false;
      setStatus(convId, { state: "connecting", kind });
      const transport = kind === "direct" ? createDirectTransport() : createOnionTransport();

      try {
        countSessionStage("adapter-start", "input");
        await connectTransport(transport, peerHint);
        countSessionStage("adapter-start", "success");

        if (states.get(convId) !== state || !state.active) { await closeTransport(transport);

 return false; }

        state.transport = transport;
        attachHandlers(state, transport);
        setStatus(convId, { state: "connected", kind, warning: kind === "direct" });
        scheduleBackoffReset(convId);
        void flushConversationOutbox(convId, transport);

        return true;
      } catch (error) {
        await closeTransport(transport);

        if (states.get(convId) !== state || !state.active) return false;
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(convId, { state: "failed", kind, detail });

        return false;
      }
    };

    const primaryConnected = await tryKind(primary);

    if (primaryConnected || states.get(convId) !== state || !state.active) return;

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
      if (states.get(convId) !== state || !state.active) return;
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(convId, { state: "failed", detail });
      scheduleRetry(convId);
    })
    .finally(() => {
      if (states.get(convId) === state) state.connectPromise = null;
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
  const context = await captureLocalOperationContext();
  const access = context?.vault;
  const state = getState(convId);

  if (!state.transport || state.status.state !== "connected") {
    await queueConversationOutbox(convId, payload, undefined, access);
    void connectConversation(convId, state.peerHint);

    return;
  }

  try {
    access?.assertLocal();
    await state.transport.send(payload);
    access?.assertLocal();
  } catch (error) {
    const detail = toErrorDetail(error);
    await queueConversationOutbox(convId, payload, detail, access);
    scheduleRetry(convId);

    return;
  }
};

export const onConversationMessage = (
  convId: string,
  handler: MessageHandler
) => {
  const state = getState(convId);

  if (state.messageHandlers.has(handler)) {
    return () => {
      state.messageHandlers.delete(handler);
    };
  }

  const wrapped: MessageHandler = (bytes, context) => {
    if (!shouldProcessIncoming(convId, bytes)) return { status: "FAILED", code: "RECEIVE_RATE_LIMITED" };

    return handler(bytes, context);
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

const revokeConversationTransports = () => {
  const previous = Array.from(states.values());
  states.clear();
  outboxFlushes.clear();

  for (const state of previous) {
    state.active = false;
    clearRetryTimer(state);
    clearBackoffResetTimer(state);
    state.messageUnsubs.forEach(unsubscribe => unsubscribe());
    state.messageUnsubs = [];
    state.messageHandlers.clear();
    void closeTransport(state.transport);
  }
};

onAccountOwnerChange(revokeConversationTransports);

onVaultKeyChange(revokeConversationTransports);
