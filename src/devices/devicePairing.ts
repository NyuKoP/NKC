import type { DeviceAddedEvent } from "./deviceApprovals";
import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import { RendezvousClient } from "../net/rendezvousSignaling";
import { createId } from "../utils/ids";

export type SyncCodeState = {
  code: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
};

export type PairingRequest = {
  requestId: string;
  code: string;
  deviceId: string;
  identityPub: string;
  dhPub: string;
  ts: number;
};

export type PairingResult = {
  requestId: string;
  status: "approved" | "rejected" | "error";
  message?: string;
  event?: DeviceAddedEvent;
};

type DirectSignalTransport = ReturnType<typeof createDirectP2PTransport> & {
  createOfferCode: () => Promise<string>;
  acceptSignalCode: (code: string) => Promise<void>;
  onSignalCode: (cb: (code: string) => void) => void;
  onState: (cb: (state: "idle" | "connecting" | "connected" | "failed" | "degraded") => void) => void;
};

export type RendezvousPairingStatus =
  | "idle"
  | "connecting"
  | "exchanging"
  | "connected"
  | "error";

export type RendezvousPairingSession = {
  syncCode: string;
  stop: () => void;
  getStatus: () => RendezvousPairingStatus;
  onStatus: (cb: (status: RendezvousPairingStatus) => void) => () => void;
};

const CHANNEL_NAME = "nkc-device-pairing-v1";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const activeCodes = new Map<string, SyncCodeState>();
const pendingRequests = new Map<string, PairingRequest>();
const requestListeners = new Set<(req: PairingRequest) => void>();
const resultListeners = new Set<(res: PairingResult) => void>();

const channel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

type PairingMessage =
  | {
      type: "PAIR_REQ";
      code: string;
      requestId: string;
      deviceId: string;
      identityPub: string;
      dhPub: string;
      ts: number;
    }
  | {
      type: "PAIR_RES";
      requestId: string;
      status: PairingResult["status"];
      message?: string;
      event?: DeviceAddedEvent;
    };

const normalizeCode = (value: string) => value.replace(/[\s-]+/g, "").toUpperCase();

const toBase32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      const index = (value >> (bits - 5)) & 31;
      output += CODE_ALPHABET[index];
      bits -= 5;
    }
  }
  if (bits > 0) {
    const index = (value << (5 - bits)) & 31;
    output += CODE_ALPHABET[index];
  }
  return output;
};

const generateShortSyncCode = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const raw = toBase32(bytes).slice(0, 6);
  return `NKC-SYNC1-${raw}`;
};

const generateCode = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const raw = toBase32(bytes).slice(0, 8);
  const partA = raw.slice(0, 4);
  const partB = raw.slice(4, 8);
  return `NKC-SYNC-${partA}-${partB}`;
};

const cleanupExpiredCodes = () => {
  const now = Date.now();
  for (const [code, entry] of activeCodes.entries()) {
    if (entry.expiresAt <= now) {
      activeCodes.delete(code);
    }
  }
};

const emitRequest = (req: PairingRequest) => {
  requestListeners.forEach((listener) => {
    try {
      listener(req);
    } catch {
      // ignore listener errors
    }
  });
};

const emitResult = (res: PairingResult) => {
  resultListeners.forEach((listener) => {
    try {
      listener(res);
    } catch {
      // ignore listener errors
    }
  });
};

const postMessage = (message: PairingMessage) => {
  if (channel) {
    channel.postMessage(message);
  } else {
    handleMessage(message);
  }
};

const respondWithError = (requestId: string, message: string) => {
  postMessage({ type: "PAIR_RES", requestId, status: "error", message });
};

const handlePairReq = (message: Extract<PairingMessage, { type: "PAIR_REQ" }>) => {
  cleanupExpiredCodes();
  const code = normalizeCode(message.code);
  const entry = activeCodes.get(code);
  if (!entry) {
    respondWithError(message.requestId, "코드가 유효하지 않습니다.");
    return;
  }
  if (entry.expiresAt <= Date.now()) {
    activeCodes.delete(code);
    respondWithError(message.requestId, "코드가 만료되었습니다.");
    return;
  }
  if (entry.used) {
    respondWithError(message.requestId, "코드가 이미 사용되었습니다.");
    return;
  }
  entry.used = true;

  const req: PairingRequest = {
    requestId: message.requestId,
    code: entry.code,
    deviceId: message.deviceId,
    identityPub: message.identityPub,
    dhPub: message.dhPub,
    ts: message.ts ?? Date.now(),
  };
  pendingRequests.set(req.requestId, req);
  emitRequest(req);
};

const handlePairRes = (message: Extract<PairingMessage, { type: "PAIR_RES" }>) => {
  emitResult({
    requestId: message.requestId,
    status: message.status,
    message: message.message,
    event: message.event,
  });
};

const handleMessage = (message: PairingMessage) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "PAIR_REQ") {
    handlePairReq(message);
    return;
  }
  if (message.type === "PAIR_RES") {
    handlePairRes(message);
  }
};

if (channel) {
  channel.onmessage = (event) => {
    handleMessage(event.data as PairingMessage);
  };
}

export const createSyncCode = (ttlMs: number = DEFAULT_TTL_MS): SyncCodeState => {
  cleanupExpiredCodes();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const formatted = generateCode();
  const normalized = normalizeCode(formatted);
  const entry: SyncCodeState = { code: formatted, issuedAt, expiresAt, used: false };
  activeCodes.set(normalized, entry);
  return entry;
};

export const getSyncCodeState = (code: string) => {
  const entry = activeCodes.get(normalizeCode(code));
  if (!entry) return null;
  return { ...entry };
};

export const onPairingRequest = (listener: (req: PairingRequest) => void) => {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
};

export const onPairingResult = (listener: (res: PairingResult) => void) => {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
};

export const submitSyncCode = (payload: {
  code: string;
  deviceId: string;
  identityPub: string;
  dhPub: string;
}) => {
  const requestId = createId();
  postMessage({
    type: "PAIR_REQ",
    code: normalizeCode(payload.code),
    requestId,
    deviceId: payload.deviceId,
    identityPub: payload.identityPub,
    dhPub: payload.dhPub,
    ts: Date.now(),
  });
  return requestId;
};

export const approvePairingRequest = (requestId: string, event: DeviceAddedEvent) => {
  pendingRequests.delete(requestId);
  postMessage({ type: "PAIR_RES", requestId, status: "approved", event });
};

export const rejectPairingRequest = (requestId: string, message: string) => {
  pendingRequests.delete(requestId);
  postMessage({ type: "PAIR_RES", requestId, status: "rejected", message });
};

const createRendezvousSession = (syncCode: string) => {
  let status: RendezvousPairingStatus = "idle";
  const listeners = new Set<(next: RendezvousPairingStatus) => void>();
  const setStatus = (next: RendezvousPairingStatus) => {
    status = next;
    listeners.forEach((listener) => listener(next));
  };
  return {
    syncCode,
    setStatus,
    getStatus: () => status,
    onStatus: (cb: (next: RendezvousPairingStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
};

const startPolling = (args: {
  client: RendezvousClient;
  syncCode: string;
  deviceId: string;
  onItems: (payloads: string[]) => Promise<void>;
  onError: (error: unknown) => void;
  setStatus: (status: RendezvousPairingStatus) => void;
  activeRef: { current: boolean };
}) => {
  let afterTs = 0;
  let timer: number | null = null;
  const intervals = [900, 1500, 2500];
  let backoffIndex = 0;

  const tick = async () => {
    if (!args.activeRef.current) return;
    try {
      const result = await args.client.poll(args.syncCode, args.deviceId, afterTs);
      afterTs = result.nextAfterTs;
      backoffIndex = 0;
      if (result.items.length) {
        const payloads = result.items.map((item) => item.payload);
        await args.onItems(payloads);
        if (args.activeRef.current) args.setStatus("exchanging");
      }
    } catch (error) {
      backoffIndex = Math.min(backoffIndex + 1, intervals.length - 1);
      args.onError(error);
    } finally {
      if (!args.activeRef.current) return;
      const delay = intervals[backoffIndex];
      timer = window.setTimeout(tick, delay);
    }
  };

  timer = window.setTimeout(tick, intervals[0]);
  return () => {
    if (timer) window.clearTimeout(timer);
  };
};

export const startRendezvousPairingAsHost = (args: {
  baseUrl: string;
  deviceId: string;
  useOnionProxy: boolean;
  onionProxyUrl?: string | null;
  syncCode?: string;
}): RendezvousPairingSession => {
  const syncCode = args.syncCode ?? generateShortSyncCode();
  const session = createRendezvousSession(syncCode);
  const activeRef = { current: true };
  const client = new RendezvousClient({
    baseUrl: args.baseUrl,
    useOnionProxy: args.useOnionProxy,
    onionProxyUrl: args.onionProxyUrl,
  });
  const transport = createDirectP2PTransport() as DirectSignalTransport;

  const stopPolling = startPolling({
    client,
    syncCode,
    deviceId: args.deviceId,
    onItems: async (payloads) => {
      await Promise.all(payloads.map((payload) => transport.acceptSignalCode(payload)));
    },
    onError: () => session.setStatus("error"),
    setStatus: session.setStatus,
    activeRef,
  });

  transport.onSignalCode((code) => {
    if (!activeRef.current) return;
    void client.publish(syncCode, args.deviceId, [code]).catch(() => {
      if (activeRef.current) session.setStatus("error");
    });
  });

  transport.onState((next) => {
    if (!activeRef.current) return;
    if (next === "connected") session.setStatus("connected");
  });

  const start = async () => {
    try {
      session.setStatus("connecting");
      await transport.start();
      const offer = await transport.createOfferCode();
      await client.publish(syncCode, args.deviceId, [offer]);
      session.setStatus("exchanging");
    } catch {
      session.setStatus("error");
    }
  };

  void start();

  return {
    syncCode,
    getStatus: session.getStatus,
    onStatus: session.onStatus,
    stop: () => {
      activeRef.current = false;
      stopPolling();
      void transport.stop();
      session.setStatus("idle");
    },
  };
};

export const startRendezvousPairingAsGuest = (args: {
  baseUrl: string;
  deviceId: string;
  syncCode: string;
  useOnionProxy: boolean;
  onionProxyUrl?: string | null;
}): RendezvousPairingSession => {
  const session = createRendezvousSession(args.syncCode);
  const activeRef = { current: true };
  const client = new RendezvousClient({
    baseUrl: args.baseUrl,
    useOnionProxy: args.useOnionProxy,
    onionProxyUrl: args.onionProxyUrl,
  });
  const transport = createDirectP2PTransport() as DirectSignalTransport;

  const stopPolling = startPolling({
    client,
    syncCode: args.syncCode,
    deviceId: args.deviceId,
    onItems: async (payloads) => {
      await Promise.all(payloads.map((payload) => transport.acceptSignalCode(payload)));
    },
    onError: () => session.setStatus("error"),
    setStatus: session.setStatus,
    activeRef,
  });

  transport.onSignalCode((code) => {
    if (!activeRef.current) return;
    void client.publish(args.syncCode, args.deviceId, [code]).catch(() => {
      if (activeRef.current) session.setStatus("error");
    });
  });

  transport.onState((next) => {
    if (!activeRef.current) return;
    if (next === "connected") session.setStatus("connected");
  });

  const start = async () => {
    try {
      session.setStatus("connecting");
      await transport.start();
    } catch {
      session.setStatus("error");
    }
  };

  void start();

  return {
    syncCode: args.syncCode,
    getStatus: session.getStatus,
    onStatus: session.onStatus,
    stop: () => {
      activeRef.current = false;
      stopPolling();
      void transport.stop();
      session.setStatus("idle");
    },
  };
};
