import type { TransportPacket } from "../../adapters/transports/types";
import { OnionInboxClient } from "../onionInboxClient";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { createId } from "../../utils/ids";
import { useInternalOnionRouteStore } from "../../stores/internalOnionRouteStore";
import type { HopAckMessage, HopPongMessage, InternalOnionControlPlaneMessage } from "./types";

const RELAY_FRAME_TYPE = "internal_onion_relay";
const RELAY_FRAME_VERSION = 1;
const RELAY_TTL_MS = 90_000;
const MAX_CHAIN_LENGTH = 8;

type RelayControlPayload = {
  kind: "control";
  message: InternalOnionControlPlaneMessage;
};

type RelayDataPayload = {
  kind: "data";
  packet: TransportPacket;
};

type RelayPayload = RelayControlPayload | RelayDataPayload;

type RelayEnvelope = {
  type: typeof RELAY_FRAME_TYPE;
  v: typeof RELAY_FRAME_VERSION;
  ts: number;
  circuitId: string;
  senderPeerId: string;
  chain: string[];
  hopCursor: number;
  payload: RelayPayload;
};

type RelayHandleResult = {
  handled: boolean;
  deliveredPacket?: TransportPacket;
};

type ControlHandlers = {
  onAck: (message: HopAckMessage) => void;
  onPong: (message: HopPongMessage) => void;
};

type RelayDeps = {
  now: () => number;
  getLocalPeerId: () => string;
  sendRelayEnvelope: (toPeerId: string, envelope: RelayEnvelope) => Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedClient: OnionInboxClient | null = null;
let cachedClientDeviceId: string | null = null;
let cachedBaseUrl: string | null = null;
let controlHandlers: ControlHandlers | null = null;

const resolveControllerUrl = async () => {
  const nkc = (
    globalThis as {
      nkc?: { getOnionControllerUrl?: () => Promise<string> };
    }
  ).nkc;
  if (nkc?.getOnionControllerUrl) {
    try {
      const url = await nkc.getOnionControllerUrl();
      if (typeof url === "string" && url.trim()) {
        return url.trim();
      }
    } catch {
      // fallthrough
    }
  }
  return "http://127.0.0.1:3210";
};

const getClient = async () => {
  const deviceId = getOrCreateDeviceId();
  const baseUrl = await resolveControllerUrl();
  if (
    cachedClient &&
    cachedClientDeviceId === deviceId &&
    cachedBaseUrl === baseUrl
  ) {
    return cachedClient;
  }
  cachedClient = new OnionInboxClient({
    baseUrl,
    deviceId,
  });
  cachedClientDeviceId = deviceId;
  cachedBaseUrl = baseUrl;
  return cachedClient;
};

const defaultDeps: RelayDeps = {
  now: Date.now,
  getLocalPeerId: () => getOrCreateDeviceId(),
  sendRelayEnvelope: async (toPeerId, envelope) => {
    const client = await getClient();
    const payloadText = JSON.stringify(envelope);
    const envelopeB64 = encodeBase64Url(encoder.encode(payloadText));
    const result = await client.send(toPeerId, envelopeB64, RELAY_TTL_MS);
    if (!result.ok) {
      throw new Error(result.error ?? "relay send failed");
    }
  },
};

let deps: RelayDeps = defaultDeps;

const toRelayPacket = (envelope: RelayEnvelope): TransportPacket => ({
  id: createId(),
  payload: JSON.stringify(envelope),
});

const decodePayloadToText = (payload: TransportPacket["payload"]) => {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return decoder.decode(payload);
  if (payload && typeof payload === "object" && "b64" in payload) {
    const b64 = (payload as { b64?: unknown }).b64;
    if (typeof b64 !== "string") return null;
    try {
      return decoder.decode(decodeBase64Url(b64));
    } catch {
      return null;
    }
  }
  return null;
};

const isRelayEnvelope = (value: unknown): value is RelayEnvelope => {
  if (!value || typeof value !== "object") return false;
  const typed = value as Partial<RelayEnvelope>;
  return typed.type === RELAY_FRAME_TYPE && typed.v === RELAY_FRAME_VERSION;
};

const buildChainForHop = (hopIndex: number) => {
  const route = useInternalOnionRouteStore.getState().route;
  const chain = route.hops
    .filter((hop) => hop.hopIndex <= hopIndex && typeof hop.peerId === "string" && hop.peerId.trim())
    .map((hop) => (hop.peerId as string).trim());
  return Array.from(new Set(chain));
};

const resolveDataTargetPeerId = (packet: TransportPacket) =>
  (packet as { toDeviceId?: string }).toDeviceId ??
  (packet as { meta?: { toDeviceId?: string } }).meta?.toDeviceId ??
  (packet as { route?: { toDeviceId?: string } }).route?.toDeviceId ??
  (packet as { to?: string }).to ??
  (packet as { route?: { to?: string } }).route?.to ??
  (packet as { meta?: { to?: string } }).meta?.to;

const buildRelayChainForData = (targetPeerId: string) => {
  const route = useInternalOnionRouteStore.getState().route;
  const relays = route.hops
    .map((hop) => hop.peerId?.trim())
    .filter((peerId): peerId is string => Boolean(peerId));
  const dedupedRelays = Array.from(new Set(relays.filter((peerId) => peerId !== targetPeerId)));
  const chain = [...dedupedRelays, targetPeerId];
  return chain.slice(0, MAX_CHAIN_LENGTH);
};

const sendEnvelope = async (envelope: RelayEnvelope) => {
  if (!envelope.chain.length) {
    throw new Error("relay chain empty");
  }
  if (envelope.chain.length > MAX_CHAIN_LENGTH) {
    throw new Error("relay chain too long");
  }
  const firstPeerId = envelope.chain[0];
  await deps.sendRelayEnvelope(firstPeerId, envelope);
};

const buildRelayEnvelope = (args: {
  circuitId: string;
  chain: string[];
  hopCursor: number;
  payload: RelayPayload;
}): RelayEnvelope => ({
  type: RELAY_FRAME_TYPE,
  v: RELAY_FRAME_VERSION,
  ts: deps.now(),
  circuitId: args.circuitId,
  senderPeerId: deps.getLocalPeerId(),
  chain: args.chain,
  hopCursor: args.hopCursor,
  payload: args.payload,
});

const sendControlToPeer = async (
  toPeerId: string,
  message: HopAckMessage | HopPongMessage
) => {
  const envelope = buildRelayEnvelope({
    circuitId: message.circuitId,
    chain: [toPeerId],
    hopCursor: 0,
    payload: { kind: "control", message },
  });
  await sendEnvelope(envelope);
};

export const registerInternalOnionControlHandlers = (handlers: ControlHandlers) => {
  controlHandlers = handlers;
};

export const sendControlPlaneMessage = async (
  message: InternalOnionControlPlaneMessage
) => {
  if (message.type !== "HOP_HELLO" && message.type !== "HOP_PING") return;
  const chain = buildChainForHop(message.hopIndex);
  if (!chain.length) {
    throw new Error("relay chain unavailable");
  }
  const envelope = buildRelayEnvelope({
    circuitId: message.circuitId,
    chain,
    hopCursor: 0,
    payload: {
      kind: "control",
      message,
    },
  });
  await sendEnvelope(envelope);
};

export const sendDataViaCurrentRoute = async (packet: TransportPacket) => {
  const route = useInternalOnionRouteStore.getState().route;
  if (route.status !== "ready") {
    throw new Error("internal onion route not ready");
  }
  const targetPeerId = resolveDataTargetPeerId(packet)?.trim();
  if (!targetPeerId) {
    throw new Error("internal onion target peer missing");
  }
  const chain = buildRelayChainForData(targetPeerId);
  if (!chain.length) {
    throw new Error("internal onion relay chain is empty");
  }
  const circuitId = route.circuitId ?? createId();
  const envelope = buildRelayEnvelope({
    circuitId,
    chain,
    hopCursor: 0,
    payload: {
      kind: "data",
      packet,
    },
  });
  await sendEnvelope(envelope);
};

export const handleIncomingRelayPacket = async (
  packet: TransportPacket
): Promise<RelayHandleResult> => {
  const raw = decodePayloadToText(packet.payload);
  if (!raw) return { handled: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { handled: false };
  }
  if (!isRelayEnvelope(parsed)) return { handled: false };
  const envelope = parsed;
  if (
    !Array.isArray(envelope.chain) ||
    envelope.chain.length === 0 ||
    envelope.chain.length > MAX_CHAIN_LENGTH
  ) {
    return { handled: true };
  }
  if (!Number.isInteger(envelope.hopCursor) || envelope.hopCursor < 0) {
    return { handled: true };
  }
  if (envelope.hopCursor >= envelope.chain.length) {
    return { handled: true };
  }
  const localPeerId = deps.getLocalPeerId();
  if (envelope.chain[envelope.hopCursor] !== localPeerId) {
    return { handled: true };
  }
  const isFinal = envelope.hopCursor === envelope.chain.length - 1;
  if (!isFinal) {
    const nextCursor = envelope.hopCursor + 1;
    const nextPeerId = envelope.chain[nextCursor];
    const forwarded: RelayEnvelope = {
      ...envelope,
      ts: deps.now(),
      hopCursor: nextCursor,
    };
    await deps.sendRelayEnvelope(nextPeerId, forwarded);
    return { handled: true };
  }

  if (envelope.payload.kind === "data") {
    return {
      handled: true,
      deliveredPacket: envelope.payload.packet,
    };
  }

  const message = envelope.payload.message;
  if (message.type === "HOP_HELLO") {
    const ack: HopAckMessage = {
      type: "HOP_ACK",
      circuitId: message.circuitId,
      hopIndex: message.hopIndex,
      ts: deps.now(),
      relayPeerId: localPeerId,
      ok: true,
      // TODO: attach relay Ed25519 signature when key material is available.
    };
    await sendControlToPeer(envelope.senderPeerId, ack);
    return { handled: true };
  }
  if (message.type === "HOP_PING") {
    const pong: HopPongMessage = {
      type: "HOP_PONG",
      circuitId: message.circuitId,
      hopIndex: message.hopIndex,
      ts: deps.now(),
    };
    await sendControlToPeer(envelope.senderPeerId, pong);
    return { handled: true };
  }
  if (message.type === "HOP_ACK") {
    controlHandlers?.onAck(message);
    return { handled: true };
  }
  if (message.type === "HOP_PONG") {
    controlHandlers?.onPong(message);
    return { handled: true };
  }
  return { handled: true };
};

export const __testSetRelayDeps = (next: Partial<RelayDeps>) => {
  deps = {
    ...deps,
    ...next,
  };
};

export const __testResetRelayDeps = () => {
  deps = defaultDeps;
  controlHandlers = null;
};

export const __testToRelayPacket = (envelope: RelayEnvelope) => toRelayPacket(envelope);
