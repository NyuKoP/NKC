import type { TransportPacket } from "../../adapters/transports/types";
import { encodeInboxTransportPacket } from "../../adapters/transports/packetCodec";
import { OnionInboxClient } from "../onionInboxClient";
import { decodeBase64Url } from "../../security/base64url";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { captureLocalOperationContext, type ReceiveContext } from "../../accounts/receiveContext";
import { listProfiles } from "../../db/repo";
import { createId } from "../../utils/ids";
import { useInternalOnionRouteStore } from "../../stores/internalOnionRouteStore";
import {
  signLocalControlPlaneMessage,
  verifyPeerControlPlaneMessage,
} from "./controlPlaneAuth";
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
  completion?: "OWNER_BOUND_EPHEMERAL";
};

type ControlHandlers = {
  onAck: (message: HopAckMessage) => boolean | void | Promise<boolean | void>;
  onPong: (message: HopPongMessage, signerPeerId: string) => boolean | void | Promise<boolean | void>;
};

type RelayDeps = {
  now: () => number;
  getLocalPeerId: () => string;
  sendRelayEnvelope: (toPeerId: string, envelope: RelayEnvelope, context?: ReceiveContext) => Promise<void>;
  signControlMessage: <T extends InternalOnionControlPlaneMessage>(message: T, context?: ReceiveContext) => Promise<T>;
  verifyControlMessage: (
    message: InternalOnionControlPlaneMessage,
    peerId: string, context?: ReceiveContext
  ) => Promise<boolean>;
};

const decoder = new TextDecoder();

let cachedClient: OnionInboxClient | null = null;

let cachedClientDeviceId: string | null = null;

let cachedBaseUrl: string | null = null;

let cachedSession: string | undefined;

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

const getClient = async (context?: ReceiveContext) => {
  await context?.vault.assertMain();
  const deviceId = getOrCreateDeviceId(context);
  const baseUrl = await resolveControllerUrl();

  if (
    cachedClient &&
    cachedClientDeviceId === deviceId &&
    cachedBaseUrl === baseUrl && cachedSession === context?.owner.session.token
  ) {
    return cachedClient;
  }

  cachedClient = new OnionInboxClient({
    baseUrl,
    deviceId,
    receiveSession: context?.owner.session,
  });
  cachedClientDeviceId = deviceId;
  cachedBaseUrl = baseUrl;
  cachedSession = context?.owner.session.token;
  context?.vault.assertLocal();

  return cachedClient;
};

const defaultDeps: RelayDeps = {
  now: Date.now,
  getLocalPeerId: () => getOrCreateDeviceId(),
  sendRelayEnvelope: async (toPeerId, envelope, context) => {
    const client = await getClient(context);

    const peers = context ? (await listProfiles(context.vault)).filter(profile => profile.kind === "friend" &&
      profile.friendStatus !== "blocked" && profile.friendStatus !== "deleted" && profile.verification?.status !== "key_changed" &&
      [profile.primaryDeviceId, profile.routingHints?.deviceId].includes(toPeerId)) : [];

    if (context && (peers.length !== 1 || !peers[0].routingHints?.onionAddr || !peers[0].routingHints?.inboxWriteToken)) throw new Error("RELAY_PEER_ROUTE_UNAVAILABLE");

    const route = context ? { mode: "preferTor" as const, torOnion: peers[0].routingHints!.onionAddr,
      inboxWriteToken: peers[0].routingHints!.inboxWriteToken } : undefined;

    await context?.vault.assertMain();
    const envelopeB64 = encodeInboxTransportPacket(toRelayPacket(envelope));
    const result = await client.send(toPeerId, envelopeB64, RELAY_TTL_MS, route);
    await context?.vault.assertMain();

    if (!result.ok) {
      throw new Error(result.error ?? "relay send failed");
    }
  },
  signControlMessage: signLocalControlPlaneMessage,
  verifyControlMessage: verifyPeerControlPlaneMessage,
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
    const b64 = payload.b64;

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
    .filter((hop): hop is typeof hop & { peerId: string } => hop.hopIndex <= hopIndex && typeof hop.peerId === "string" && Boolean(hop.peerId.trim()))
    .map((hop) => hop.peerId.trim());

  return Array.from(new Set(chain));
};

const resolveDataTargetPeerId = (packet: TransportPacket) =>
  packet.toDeviceId ??
  packet.meta?.toDeviceId ??
  packet.route?.toDeviceId ??
  packet.to ??
  packet.route?.to ??
  packet.meta?.to;

const buildRelayChainForData = (targetPeerId: string) => {
  const route = useInternalOnionRouteStore.getState().route;

  const relays = route.hops
    .map((hop) => hop.peerId?.trim())
    .filter((peerId): peerId is string => Boolean(peerId));

  const dedupedRelays = Array.from(new Set(relays.filter((peerId) => peerId !== targetPeerId)));
  const chain = [...dedupedRelays, targetPeerId];

  return chain;
};

const sendEnvelope = async (envelope: RelayEnvelope, context?: ReceiveContext) => {
  await context?.vault.assertMain();

  if (!envelope.chain.length) {
    throw new Error("relay chain empty");
  }

  if (envelope.chain.length > MAX_CHAIN_LENGTH || envelope.chain.some(peer => typeof peer !== "string" || !peer || peer.length > 256) || new Set(envelope.chain).size !== envelope.chain.length) {
    throw new Error("relay chain too long");
  }

  const firstPeerId = envelope.chain[0];
  await deps.sendRelayEnvelope(firstPeerId, envelope, context);
  await context?.vault.assertMain();
};

const buildRelayEnvelope = (args: {
  circuitId: string;
  chain: string[];
  hopCursor: number;
  payload: RelayPayload;
}, context?: ReceiveContext): RelayEnvelope => ({
  type: RELAY_FRAME_TYPE,
  v: RELAY_FRAME_VERSION,
  ts: deps.now(),
  circuitId: args.circuitId,
  senderPeerId: context ? getOrCreateDeviceId(context) : deps.getLocalPeerId(),
  chain: args.chain,
  hopCursor: args.hopCursor,
  payload: args.payload,
});

const sendControlToPeer = async (
  toPeerId: string,
  message: HopAckMessage | HopPongMessage, context?: ReceiveContext
) => {
  const signedMessage = await deps.signControlMessage(message, context);

  const envelope = buildRelayEnvelope({
    circuitId: message.circuitId,
    chain: [toPeerId],
    hopCursor: 0,
    payload: { kind: "control", message: signedMessage },
  }, context);

  await sendEnvelope(envelope, context);
};

export const registerInternalOnionControlHandlers = (handlers: ControlHandlers) => {
  controlHandlers = handlers;
};

export const sendControlPlaneMessage = async (
  message: InternalOnionControlPlaneMessage, context?: ReceiveContext
) => {
  context ??= await captureLocalOperationContext();
  await context?.vault.assertMain();

  if (message.type !== "HOP_HELLO" && message.type !== "HOP_PING") return;
  const chain = buildChainForHop(message.hopIndex);

  if (!chain.length) {
    throw new Error("relay chain unavailable");
  }

  const signedMessage = await deps.signControlMessage(message, context);

  const envelope = buildRelayEnvelope({
    circuitId: message.circuitId,
    chain,
    hopCursor: 0,
    payload: {
      kind: "control",
      message: signedMessage,
    },
  }, context);

  await sendEnvelope(envelope, context);
};

export const sendDataViaCurrentRoute = async (packet: TransportPacket, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  await context?.vault.assertMain();
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
  }, context);

  await sendEnvelope(envelope, context);
};

export const handleIncomingRelayPacket = async (
  packet: TransportPacket, context?: ReceiveContext
): Promise<RelayHandleResult> => {
  await context?.vault.assertMain();
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

  if (!Number.isFinite(envelope.ts) || Math.abs(deps.now() - envelope.ts) > RELAY_TTL_MS ||
      typeof envelope.circuitId !== "string" || !envelope.circuitId || envelope.circuitId.length > 128 ||
      typeof envelope.senderPeerId !== "string" || !envelope.senderPeerId || envelope.senderPeerId.length > 256 ||
      !envelope.payload || !["control", "data"].includes(envelope.payload.kind)) return { handled: true };

  if (
    !Array.isArray(envelope.chain) ||
    envelope.chain.length === 0 ||
    envelope.chain.length > MAX_CHAIN_LENGTH ||
    envelope.chain.some(peer => typeof peer !== "string" || !peer || peer.length > 256) ||
    new Set(envelope.chain).size !== envelope.chain.length
  ) {
    return { handled: true };
  }

  if (!Number.isInteger(envelope.hopCursor) || envelope.hopCursor < 0) {
    return { handled: true };
  }

  if (envelope.hopCursor >= envelope.chain.length) {
    return { handled: true };
  }

  const localPeerId = context ? getOrCreateDeviceId(context) : deps.getLocalPeerId();

  if (envelope.chain[envelope.hopCursor] !== localPeerId) {
    return { handled: true };
  }

  if (envelope.payload.kind === "control") {
  const message = envelope.payload.message;

  if (!message || !["HOP_HELLO", "HOP_ACK", "HOP_PING", "HOP_PONG"].includes(message.type) ||
      message.circuitId !== envelope.circuitId || !Number.isSafeInteger(message.hopIndex) || message.hopIndex < 1 || message.hopIndex > MAX_CHAIN_LENGTH ||
      !Number.isFinite(message.ts) || Math.abs(deps.now() - message.ts) > RELAY_TTL_MS) return { handled: true };

  const signerPeerId =
    message.type === "HOP_HELLO"
      ? message.senderPeerId
      : message.type === "HOP_ACK"
        ? message.relayPeerId
        : envelope.senderPeerId;

  if (signerPeerId !== envelope.senderPeerId) {
    return { handled: true };
  }

  if (!(await deps.verifyControlMessage(message, signerPeerId, context))) {
    return { handled: true };
  }

  await context?.vault.assertMain();
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

    await deps.sendRelayEnvelope(nextPeerId, forwarded, context);
    await context?.vault.assertMain();

    return { handled: true, completion: "OWNER_BOUND_EPHEMERAL" };
  }

  if (envelope.payload.kind === "data") {
    return {
      handled: true,
      deliveredPacket: envelope.payload.packet,
    };
  }

  const message = envelope.payload.message;
  const signerPeerId = message.type === "HOP_HELLO" ? message.senderPeerId : message.type === "HOP_ACK" ? message.relayPeerId : envelope.senderPeerId;

  if (message.type === "HOP_HELLO") {
    const ack: HopAckMessage = {
      type: "HOP_ACK",
      circuitId: message.circuitId,
      hopIndex: message.hopIndex,
      ts: deps.now(),
      relayPeerId: localPeerId,
      ok: true,
    };

    await sendControlToPeer(envelope.senderPeerId, ack, context);

    return { handled: true, completion: "OWNER_BOUND_EPHEMERAL" };
  }

  if (message.type === "HOP_PING") {
    const pong: HopPongMessage = {
      type: "HOP_PONG",
      circuitId: message.circuitId,
      hopIndex: message.hopIndex,
      ts: deps.now(),
    };

    await sendControlToPeer(envelope.senderPeerId, pong, context);

    return { handled: true, completion: "OWNER_BOUND_EPHEMERAL" };
  }

  if (message.type === "HOP_ACK") {
    const applied = await controlHandlers?.onAck(message);
    await context?.vault.assertMain();

    return { handled: true, ...(applied === true ? { completion: "OWNER_BOUND_EPHEMERAL" as const } : {}) };
  }

  if (message.type === "HOP_PONG") {
    const applied = await controlHandlers?.onPong(message, signerPeerId);
    await context?.vault.assertMain();

    return { handled: true, ...(applied === true ? { completion: "OWNER_BOUND_EPHEMERAL" as const } : {}) };
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
