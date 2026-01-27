import {
  computeEnvelopeHash,
  decryptEnvelope,
  deriveConversationKey,
  encryptEnvelope,
  type Envelope,
  type EnvelopeHeader,
  verifyEnvelopeSignature,
} from "../crypto/box";
import { nextSendDhKey, nextSendKey, tryRecvDhKey, tryRecvKey } from "../crypto/ratchet";
import {
  getEvent,
  getLastEventHash,
  listConversations,
  listEventsByConv,
  listProfiles,
  saveConversation,
  saveEvent,
  saveProfile,
  type Conversation,
  type UserProfile,
} from "../db/repo";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getDhPrivateKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import { getFriendPsk } from "../security/pskStore";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { applyTOFU } from "../security/trust";
import { updateFromRoleEvent, type RoleChangeEvent } from "../devices/deviceRegistry";
import { getDeviceApproval } from "../devices/deviceApprovals";
import { createId } from "../utils/ids";
import {
  connectConversation as connectTransport,
  disconnectConversation as disconnectTransport,
  onConversationMessage,
  sendToConversation,
} from "../net/transportManager";
import type { PeerHint } from "../net/transport";
import { sanitizeRoutingHints } from "../net/privacy";
import { putReadCursor } from "../storage/receiptStore";
import { applyGroupEvent, isGroupEventPayload } from "./groupSync";

type EnvelopeEvent = {
  eventId: string;
  convId: string;
  authorDeviceId: string;
  lamport: number;
  ts: number;
  envelopeJson: string;
};

type HelloFrame = {
  type: "HELLO";
  deviceId: string;
  identityPub: string;
};

type SyncReqFrame = {
  type: "SYNC_REQ";
  scope: "conv" | "contacts" | "conversations" | "global";
  convId?: string;
  since: Record<string, number>;
};

type SyncResFrame = {
  type: "SYNC_RES";
  scope: "conv" | "contacts" | "conversations" | "global";
  convId?: string;
  events: EnvelopeEvent[];
  next: Record<string, number>;
};

type Frame = HelloFrame | SyncReqFrame | SyncResFrame;

export type PeerContext = PeerHint & {
  friendKeyId?: string;
  identityPub?: string;
  dhPub?: string;
  kind?: "friend" | "device";
  peerDeviceId?: string;
};

const contactsLogId = (convId: string) => `contacts:${convId}`;
const conversationsLogId = (convId: string) => `convs:${convId}`;
const globalLogId = (convId: string) => `global:${convId}`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const logDecrypt = (label: string, meta: { convId: string; eventId: string; mode: string }) => {
  console.debug(`[sync] ${label}`, meta);
};

const isDeviceSyncAllowed = async (convId: string, reason: string) => {
  const peer = peerContexts.get(convId);
  if (!peer || peer.kind !== "device") return true;
  const peerDeviceId = peer.peerDeviceId ?? peer.friendKeyId;
  if (!peerDeviceId) {
    console.warn("[sync] device sync blocked: missing peer device id", {
      convId,
      reason,
    });
    return false;
  }
  const localDeviceId = getOrCreateDeviceId();
  const [localApproval, peerApproval] = await Promise.all([
    getDeviceApproval(localDeviceId),
    getDeviceApproval(peerDeviceId),
  ]);
  const hasPeerApproval = Boolean(peerApproval);
  const isBoundToPeer = localApproval?.approvedBy === peerDeviceId;
  if (hasPeerApproval || isBoundToPeer) return true;
  console.warn("[sync] device sync blocked: approval not bound to peer", {
    convId,
    reason,
    localDeviceId,
    peerDeviceId,
    localApprovedBy: localApproval?.approvedBy ?? null,
    hasPeerApproval,
  });
  return false;
};

const perAuthorLamportSeen = new Map<string, number>();
const perConvLamportSeen = new Map<string, Map<string, number>>();
const peerContexts = new Map<string, PeerContext>();
const convSubscriptions = new Map<string, () => void>();
let localUserIdCache: string | null | undefined;

const resolveLocalUserId = async () => {
  if (localUserIdCache !== undefined) return localUserIdCache;
  const profiles = await listProfiles();
  const user = profiles.find((profile) => profile.kind === "user") || null;
  localUserIdCache = user?.id ?? null;
  return localUserIdCache;
};

const resolveSenderProfileId = async (peerConvId: string) => {
  const peer = peerContexts.get(peerConvId);
  if (!peer) return null;
  const profiles = await listProfiles();
  const friends = profiles.filter((profile) => profile.kind === "friend");
  const match =
    friends.find((friend) => peer.friendKeyId && friend.id === peer.friendKeyId) ||
    friends.find((friend) => peer.friendKeyId && friend.friendId === peer.friendKeyId) ||
    friends.find((friend) => peer.identityPub && friend.identityPub === peer.identityPub) ||
    null;
  return match?.id ?? null;
};

const toBytes = (frame: Frame) => textEncoder.encode(JSON.stringify(frame));

const tryParseFrame = (bytes: Uint8Array): Frame | null => {
  try {
    const raw = textDecoder.decode(bytes);
    const parsed = JSON.parse(raw) as Frame;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const getSinceMap = (convId?: string) => {
  if (!convId) {
    const since: Record<string, number> = {};
    perAuthorLamportSeen.forEach((value, key) => {
      since[key] = value;
    });
    return since;
  }
  const perConv = perConvLamportSeen.get(convId);
  if (!perConv) return {};
  const since: Record<string, number> = {};
  perConv.forEach((value, key) => {
    since[key] = value;
  });
  return since;
};

const updateLamportSeen = (convId: string, authorDeviceId: string, lamport: number) => {
  const prevAuthor = perAuthorLamportSeen.get(authorDeviceId) ?? 0;
  if (lamport > prevAuthor) perAuthorLamportSeen.set(authorDeviceId, lamport);

  let perConv = perConvLamportSeen.get(convId);
  if (!perConv) {
    perConv = new Map();
    perConvLamportSeen.set(convId, perConv);
  }
  const prevConv = perConv.get(authorDeviceId) ?? 0;
  if (lamport > prevConv) perConv.set(authorDeviceId, lamport);
};

const getLamportSeen = (convId: string, authorDeviceId: string) => {
  const perConv = perConvLamportSeen.get(convId);
  return perConv?.get(authorDeviceId) ?? 0;
};

const buildNextMap = (events: EnvelopeEvent[]) => {
  const next: Record<string, number> = {};
  for (const event of events) {
    const prev = next[event.authorDeviceId] ?? 0;
    if (event.lamport > prev) {
      next[event.authorDeviceId] = event.lamport;
    }
  }
  return next;
};

const toEnvelopeEvent = (event: EnvelopeEvent) => ({
  eventId: event.eventId,
  convId: event.convId,
  authorDeviceId: event.authorDeviceId,
  lamport: event.lamport,
  ts: event.ts,
  envelopeJson: event.envelopeJson,
});

const sortEventsDeterministic = (events: EnvelopeEvent[]) =>
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.authorDeviceId !== b.authorDeviceId) {
      return a.authorDeviceId.localeCompare(b.authorDeviceId);
    }
    return a.lamport - b.lamport;
  });

const resolveLegacyKey = async (convId: string) => {
  const peer = peerContexts.get(convId);
  if (!peer?.dhPub) return null;
  const dhPriv = await getDhPrivateKey();
  const theirDhPub = decodeBase64Url(peer.dhPub);
  const friendKeyId = peer.friendKeyId ?? peer.directAddr ?? convId;
  const pskBytes = await getFriendPsk(friendKeyId);
  const legacyContextBytes = textEncoder.encode(`direct:${friendKeyId}`);
  return deriveConversationKey(dhPriv, theirDhPub, pskBytes, legacyContextBytes);
};

const resolveRatchetBaseKey = async (peerConvId: string, contextConvId: string) => {
  const peer = peerContexts.get(peerConvId);
  if (!peer?.dhPub) return null;
  const dhPriv = await getDhPrivateKey();
  const theirDhPub = decodeBase64Url(peer.dhPub);
  const friendKeyId = peer.friendKeyId ?? peer.directAddr ?? peerConvId;
  const pskBytes = await getFriendPsk(friendKeyId);
  const contextBytes = textEncoder.encode(`conv:${contextConvId}`);
  return deriveConversationKey(dhPriv, theirDhPub, pskBytes, contextBytes);
};

const getPeerVerifyKey = async (convId: string, authorDeviceId: string) => {
  const localDeviceId = getOrCreateDeviceId();
  if (authorDeviceId === localDeviceId) {
    return getIdentityPublicKey();
  }
  const peer = peerContexts.get(convId);
  if (!peer?.identityPub) return null;
  return decodeBase64Url(peer.identityPub);
};

const applyDecryptedBody = async (
  peerConvId: string,
  conv: Conversation | null,
  envelope: Envelope,
  body: unknown
) => {
  if (!body || typeof body !== "object") return;

  const [senderId, currentUserId] = await Promise.all([
    resolveSenderProfileId(peerConvId),
    resolveLocalUserId(),
  ]);

  if (isGroupEventPayload(body)) {
    await applyGroupEvent(body, senderId, currentUserId);
    return;
  }

  const typed = body as {
    type?: string;
    kind?: string;
    convId?: string;
    cursorTs?: number;
    anchorMsgId?: string;
    msgId?: string;
    ts?: number;
  };

  if (typed.type === "rcpt" && typed.kind === "read_cursor") {
    if (!senderId || typeof typed.convId !== "string") return;
    const cursorTsCandidate = Number.isFinite(typed.cursorTs)
      ? Number(typed.cursorTs)
      : typed.ts ?? envelope.header.ts;
    if (!Number.isFinite(cursorTsCandidate)) return;
    const cursorTs = cursorTsCandidate;
    await putReadCursor({
      convId: typed.convId,
      actorId: senderId,
      cursorTs,
      anchorMsgId: typed.anchorMsgId ?? typed.msgId,
    });
    return;
  }

  if (typed.type === "msg") {
    await applyMessageEvent(conv, envelope, body as { type: "msg"; text: string; media?: unknown });
    return;
  }
  if (typed.type === "contact") {
    await applyContactEvent(body as { type: "contact"; profile: Partial<UserProfile> });
    return;
  }
  if (typed.type === "conv") {
    await applyConversationEvent(body as { type: "conv"; conv: Conversation });
    return;
  }
  if (typed.kind === "ROLE_CHANGE") {
    await updateFromRoleEvent(body as RoleChangeEvent);
  }
};

const applyMessageEvent = async (
  conv: Conversation | null,
  envelope: Envelope,
  body: { type: "msg"; text: string; media?: unknown }
) => {
  if (!conv) return;
  const lastMessage = typeof body.text === "string" ? body.text : "";
  const updated: Conversation = {
    ...conv,
    lastMessage,
    lastTs: envelope.header.ts,
  };
  await saveConversation(updated);
};

const applyContactEvent = async (body: { type: "contact"; profile: Partial<UserProfile> }) => {
  const profile = body.profile;
  if (!profile || !profile.friendId) return;
  const profiles = await listProfiles();
  const existing = profiles.find((item) => item.friendId === profile.friendId) || null;

  if (existing?.identityPub && existing.dhPub && profile.identityPub && profile.dhPub) {
    const tofu = applyTOFU(
      { identityPub: existing.identityPub, dhPub: existing.dhPub },
      { identityPub: profile.identityPub, dhPub: profile.dhPub }
    );
    if (!tofu.ok) {
      await saveProfile({
        ...existing,
        trust: {
          pinnedAt: existing.trust?.pinnedAt ?? Date.now(),
          status: "blocked",
          reason: tofu.reason,
        },
        friendStatus: "blocked",
        updatedAt: Date.now(),
      });
      return;
    }
  }

  const now = Date.now();
  const sanitizedHints = sanitizeRoutingHints(
    profile.routingHints ?? existing?.routingHints
  );
  const next: UserProfile = {
    id: existing?.id ?? createId(),
    friendId: profile.friendId,
    displayName: profile.displayName ?? existing?.displayName ?? "Friend",
    status: profile.status ?? existing?.status ?? "",
    theme: (profile.theme as UserProfile["theme"]) ?? existing?.theme ?? "dark",
    kind: "friend",
    friendStatus: profile.friendStatus ?? existing?.friendStatus ?? "normal",
    isFavorite: profile.isFavorite ?? existing?.isFavorite ?? false,
    identityPub: profile.identityPub ?? existing?.identityPub,
    dhPub: profile.dhPub ?? existing?.dhPub,
    routingHints: sanitizedHints,
    trust: existing?.trust ?? { pinnedAt: now, status: "trusted" },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveProfile(next);
};

const applyConversationEvent = async (body: { type: "conv"; conv: Conversation }) => {
  const incoming = body.conv;
  if (!incoming?.id) return;
  const existing = (await listConversations()).find((item) => item.id === incoming.id) || null;
  const merged: Conversation = {
    id: incoming.id,
    type: incoming.type ?? existing?.type ?? "direct",
    name: incoming.name ?? existing?.name ?? "Chat",
    pinned: incoming.pinned ?? existing?.pinned ?? false,
    unread: incoming.unread ?? existing?.unread ?? 0,
    hidden: incoming.hidden ?? existing?.hidden ?? false,
    muted: incoming.muted ?? existing?.muted ?? false,
    blocked: incoming.blocked ?? existing?.blocked ?? false,
    pendingAcceptance: incoming.pendingAcceptance ?? existing?.pendingAcceptance,
    lastTs: incoming.lastTs ?? existing?.lastTs ?? Date.now(),
    lastMessage: incoming.lastMessage ?? existing?.lastMessage ?? "",
    participants: incoming.participants ?? existing?.participants ?? [],
  };
  await saveConversation(merged);
};

const applyEnvelopeEvents = async (convKeyId: string, events: EnvelopeEvent[]) => {
  const unique = new Map<string, EnvelopeEvent>();
  for (const event of events) {
    if (!event?.eventId) continue;
    unique.set(event.eventId, event);
  }

  const sorted = sortEventsDeterministic(Array.from(unique.values()));
  const convs = await listConversations();
  const conv = convs.find((item) => item.id === convKeyId) || null;

  for (const event of sorted) {
    if (!Number.isFinite(event.lamport)) {
      console.warn("[sync] invalid lamport", { convId: event.convId });
      continue;
    }
    const seenLamport = getLamportSeen(event.convId, event.authorDeviceId);
    if (event.lamport <= seenLamport) {
      console.warn("[sync] replay event dropped", {
        convId: event.convId,
        authorDeviceId: event.authorDeviceId,
        lamport: event.lamport,
      });
      continue;
    }
    const existing = await getEvent(event.eventId);
    if (existing) {
      updateLamportSeen(event.convId, event.authorDeviceId, event.lamport);
      continue;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(event.envelopeJson) as Envelope;
    } catch (error) {
      console.warn("[sync] invalid envelope json", error);
      continue;
    }

    if (!envelope?.header || envelope.header.eventId !== event.eventId) {
      console.warn("[sync] invalid envelope header", envelope?.header);
      continue;
    }

    try {
      const verifyKey = await getPeerVerifyKey(convKeyId, envelope.header.authorDeviceId);
      if (!verifyKey) {
        console.warn("[sync] missing verify key");
        continue;
      }

      const verified = await verifyEnvelopeSignature(envelope, verifyKey);
      if (!verified) {
        console.warn("[sync] signature invalid");
        continue;
      }

      const rk = envelope.header.rk;
      if (rk && rk.v === 2 && Number.isFinite(rk.i) && typeof rk.dh === "string") {
        logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "v2" });
        const ratchetBaseKey = await resolveRatchetBaseKey(convKeyId, envelope.header.convId);
        if (!ratchetBaseKey) {
          console.warn("[sync] missing conversation key");
          continue;
        }
        const recv = await tryRecvDhKey(envelope.header.convId, ratchetBaseKey, rk);
        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: event.convId, eventId: event.eventId, mode: "v2" });
          continue;
        }
        const body = await decryptEnvelope<{ type: string }>(
          recv.msgKey,
          envelope,
          verifyKey
        );

        logDecrypt("commit", { convId: event.convId, eventId: event.eventId, mode: "v2" });
        await recv.commit();
        const eventHash = await computeEnvelopeHash(envelope);
        const expectedPrev = await getLastEventHash(envelope.header.convId);
        const mismatch = envelope.header.prev !== expectedPrev;
        if (mismatch) {
          console.warn("[sync] event chain mismatch");
        }
        await saveEvent({
          eventId: envelope.header.eventId,
          convId: envelope.header.convId,
          authorDeviceId: envelope.header.authorDeviceId,
          lamport: envelope.header.lamport,
          ts: envelope.header.ts,
          envelopeJson: JSON.stringify(envelope),
          prevHash: envelope.header.prev,
          eventHash,
          conflict: mismatch || undefined,
        });
        updateLamportSeen(event.convId, event.authorDeviceId, event.lamport);
        await applyDecryptedBody(convKeyId, conv, envelope, body);
        continue;
      }

      if (rk && rk.v === 1 && Number.isFinite(rk.i)) {
        logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "v1" });
        const ratchetBaseKey = await resolveRatchetBaseKey(convKeyId, envelope.header.convId);
        if (!ratchetBaseKey) {
          console.warn("[sync] missing conversation key");
          continue;
        }
        const recv = await tryRecvKey(envelope.header.convId, ratchetBaseKey, rk.i);
        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: event.convId, eventId: event.eventId, mode: "v1" });
          continue;
        }
        const body = await decryptEnvelope<{ type: string }>(
          recv.msgKey,
          envelope,
          verifyKey
        );

        logDecrypt("ok", { convId: event.convId, eventId: event.eventId, mode: "v1" });
        const eventHash = await computeEnvelopeHash(envelope);
        const expectedPrev = await getLastEventHash(envelope.header.convId);
        const mismatch = envelope.header.prev !== expectedPrev;
        if (mismatch) {
          console.warn("[sync] event chain mismatch");
        }
        await saveEvent({
          eventId: envelope.header.eventId,
          convId: envelope.header.convId,
          authorDeviceId: envelope.header.authorDeviceId,
          lamport: envelope.header.lamport,
          ts: envelope.header.ts,
          envelopeJson: JSON.stringify(envelope),
          prevHash: envelope.header.prev,
          eventHash,
          conflict: mismatch || undefined,
        });
        updateLamportSeen(event.convId, event.authorDeviceId, event.lamport);
        await applyDecryptedBody(convKeyId, conv, envelope, body);
        continue;
      }

      const conversationKey = await resolveLegacyKey(convKeyId);
      if (!conversationKey) {
        console.warn("[sync] missing conversation key");
        continue;
      }
      logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "legacy" });
      const body = await decryptEnvelope<{ type: string }>(
        conversationKey,
        envelope,
        verifyKey
      );

      logDecrypt("ok", { convId: event.convId, eventId: event.eventId, mode: "legacy" });
      const eventHash = await computeEnvelopeHash(envelope);
      const expectedPrev = await getLastEventHash(envelope.header.convId);
      const mismatch = envelope.header.prev !== expectedPrev;
      if (mismatch) {
        console.warn("[sync] event chain mismatch");
      }
      await saveEvent({
        eventId: envelope.header.eventId,
        convId: envelope.header.convId,
        authorDeviceId: envelope.header.authorDeviceId,
        lamport: envelope.header.lamport,
        ts: envelope.header.ts,
        envelopeJson: JSON.stringify(envelope),
        prevHash: envelope.header.prev,
        eventHash,
        conflict: mismatch || undefined,
      });
      updateLamportSeen(event.convId, event.authorDeviceId, event.lamport);
      await applyDecryptedBody(convKeyId, conv, envelope, body);
    } catch (error) {
      console.warn("[sync] decrypt/apply failed", error);
    }
  }
};

const sendFrame = async (convId: string, frame: Frame) => {
  try {
    await sendToConversation(convId, toBytes(frame));
  } catch (error) {
    console.warn("[sync] send failed", error);
  }
};

const handleSyncReq = async (convId: string, frame: SyncReqFrame) => {
  const allowed = await isDeviceSyncAllowed(convId, "sync_req");
  if (!allowed) return;

  const scopeConvId =
    frame.scope === "contacts"
      ? contactsLogId(frame.convId ?? convId)
      : frame.scope === "conversations"
        ? conversationsLogId(frame.convId ?? convId)
        : frame.scope === "global"
          ? globalLogId(frame.convId ?? convId)
          : frame.convId ?? convId;
  const all = await listEventsByConv(scopeConvId);
  const since = frame.since ?? {};
  const events = all.filter((event) => {
    const lastSeen = since[event.authorDeviceId] ?? 0;
    return event.lamport > lastSeen;
  });
  const next = buildNextMap(all as EnvelopeEvent[]);
  const response: SyncResFrame = {
    type: "SYNC_RES",
    scope: frame.scope,
    convId: frame.convId,
    events: events.map((event) => toEnvelopeEvent(event as EnvelopeEvent)),
    next,
  };
  await sendFrame(convId, response);
};

const handleSyncRes = async (convId: string, frame: SyncResFrame) => {
  const allowed = await isDeviceSyncAllowed(convId, "sync_res");
  if (!allowed) return;

  const targetConvId =
    frame.scope === "contacts"
      ? contactsLogId(frame.convId ?? convId)
      : frame.scope === "conversations"
        ? conversationsLogId(frame.convId ?? convId)
        : frame.scope === "global"
          ? globalLogId(frame.convId ?? convId)
          : frame.convId ?? convId;
  const events = Array.isArray(frame.events) ? frame.events : [];
  await applyEnvelopeEvents(convId, events);
  Object.entries(frame.next ?? {}).forEach(([deviceId, lamport]) => {
    if (!Number.isFinite(lamport)) return;
    updateLamportSeen(targetConvId, deviceId, lamport);
  });
};

const handleHello = async (convId: string, frame: HelloFrame) => {
  const existing = peerContexts.get(convId) ?? {};
  peerContexts.set(convId, { ...existing, identityPub: frame.identityPub });
};

const handleIncoming = async (convId: string, bytes: Uint8Array) => {
  const frame = tryParseFrame(bytes);
  if (!frame) return;
  if (frame.type === "HELLO") {
    await handleHello(convId, frame);
    return;
  }
  if (frame.type === "SYNC_REQ") {
    await handleSyncReq(convId, frame);
    return;
  }
  if (frame.type === "SYNC_RES") {
    await handleSyncRes(convId, frame);
  }
};

export const connectConversation = async (convId: string, peerHint: PeerContext) => {
  peerContexts.set(convId, peerHint);
  const allowed = await isDeviceSyncAllowed(convId, "connect");
  if (!allowed) return;
  if (!convSubscriptions.has(convId)) {
    const unsubscribe = onConversationMessage(convId, (bytes) => {
      void handleIncoming(convId, bytes);
    });
    convSubscriptions.set(convId, unsubscribe);
  }
  await connectTransport(convId, peerHint);
  const identityPub = await getIdentityPublicKey();
  const hello: HelloFrame = {
    type: "HELLO",
    deviceId: getOrCreateDeviceId(),
    identityPub: encodeBase64Url(identityPub),
  };
  await sendFrame(convId, hello);
  await syncConversation(convId);
  await syncGlobal(convId);
};

export const disconnectConversation = async (convId: string) => {
  const unsubscribe = convSubscriptions.get(convId);
  if (unsubscribe) {
    unsubscribe();
    convSubscriptions.delete(convId);
  }
  await disconnectTransport(convId);
};

export const syncConversation = async (convId: string) => {
  const allowed = await isDeviceSyncAllowed(convId, "sync_conversation");
  if (!allowed) return;
  const since = getSinceMap(convId);
  const frame: SyncReqFrame = {
    type: "SYNC_REQ",
    scope: "conv",
    convId,
    since,
  };
  await sendFrame(convId, frame);
};

export const syncGlobal = async (convId: string) => {
  const allowed = await isDeviceSyncAllowed(convId, "sync_global");
  if (!allowed) return;
  const since = getSinceMap(globalLogId(convId));
  const frame: SyncReqFrame = {
    type: "SYNC_REQ",
    scope: "global",
    convId,
    since,
  };
  await sendFrame(convId, frame);
};

const buildRoleChangeEvent = async (
  convId: string,
  payload: RoleChangeEvent,
  identityPriv: Uint8Array
) => {
  const logId = globalLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId);
  const legacyKey = await resolveLegacyKey(convId);
  if (!ratchetBaseKey || !legacyKey) return null;
  const deviceId = getOrCreateDeviceId();
  let nextLamport = perAuthorLamportSeen.get(deviceId) ?? 0;
  nextLamport += 1;

  const header: EnvelopeHeader = {
    v: 1 as const,
    eventId: createId(),
    convId: logId,
    ts: payload.ts,
    lamport: nextLamport,
    authorDeviceId: deviceId,
  };
  header.prev = await getLastEventHash(logId);
  let keyForEnvelope = legacyKey;
  try {
    const ratchet = await nextSendDhKey(logId, ratchetBaseKey);
    header.rk = ratchet.headerRk;
    keyForEnvelope = ratchet.msgKey;
  } catch {
    try {
      const ratchet = await nextSendKey(logId, ratchetBaseKey);
      header.rk = ratchet.headerRk;
      keyForEnvelope = ratchet.msgKey;
    } catch (error) {
      console.warn("[ratchet] global send fallback to legacy", error);
    }
  }

  const envelope = await encryptEnvelope(keyForEnvelope, header, payload, identityPriv);
  const eventHash = await computeEnvelopeHash(envelope);
  const event: EnvelopeEvent = {
    eventId: header.eventId,
    convId: logId,
    authorDeviceId: header.authorDeviceId,
    lamport: header.lamport,
    ts: header.ts,
    envelopeJson: JSON.stringify(envelope),
  };
  await saveEvent({
    ...event,
    prevHash: header.prev,
    eventHash,
  });
  updateLamportSeen(logId, header.authorDeviceId, header.lamport);
  return event;
};

export const emitRoleChangeEvent = async (payload: RoleChangeEvent) => {
  const identityPriv = await getIdentityPrivateKey();
  const activeConvs = Array.from(peerContexts.keys());
  for (const convId of activeConvs) {
    try {
      const event = await buildRoleChangeEvent(convId, payload, identityPriv);
      if (!event) continue;
      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "global",
        convId,
        events: [event],
        next: buildNextMap([event]),
      };
      await sendFrame(convId, frame);
    } catch (error) {
      console.warn("[sync] role change emit failed", error);
    }
  }
};

const buildContactEvents = async (convId: string) => {
  const peer = peerContexts.get(convId);
  if (!peer?.friendKeyId || !peer.dhPub) return [];
  const logId = contactsLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId);
  const legacyKey = await resolveLegacyKey(convId);
  if (!ratchetBaseKey || !legacyKey) return [];
  const identityPriv = await getIdentityPrivateKey();
  const deviceId = getOrCreateDeviceId();
  let nextLamport = perAuthorLamportSeen.get(deviceId) ?? 0;

  const profiles = await listProfiles();
  const contacts = profiles.filter((profile) => profile.kind === "friend");
  const events: EnvelopeEvent[] = [];

  let prevHash = await getLastEventHash(logId);
  for (const contact of contacts) {
    nextLamport += 1;
    const header: EnvelopeHeader = {
      v: 1 as const,
      eventId: createId(),
      convId: logId,
      ts: Date.now(),
      lamport: nextLamport,
      authorDeviceId: deviceId,
    };
    header.prev = prevHash;
    let keyForEnvelope = legacyKey;
    try {
      const ratchet = await nextSendDhKey(logId, ratchetBaseKey);
      header.rk = ratchet.headerRk;
      keyForEnvelope = ratchet.msgKey;
    } catch {
      try {
        const ratchet = await nextSendKey(logId, ratchetBaseKey);
        header.rk = ratchet.headerRk;
        keyForEnvelope = ratchet.msgKey;
      } catch (error) {
        console.warn("[ratchet] contacts send fallback to legacy", error);
      }
    }
    const envelope = await encryptEnvelope(
      keyForEnvelope,
      header,
      {
        type: "contact",
        profile: {
          friendId: contact.friendId,
          displayName: contact.displayName,
          status: contact.status,
          theme: contact.theme,
          friendStatus: contact.friendStatus,
          isFavorite: contact.isFavorite,
          identityPub: contact.identityPub,
          dhPub: contact.dhPub,
          routingHints: sanitizeRoutingHints(contact.routingHints),
        },
      },
      identityPriv
    );
    const eventHash = await computeEnvelopeHash(envelope);
    events.push({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
    });
    prevHash = eventHash;
    updateLamportSeen(logId, header.authorDeviceId, header.lamport);
    await saveEvent({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
      prevHash: header.prev,
      eventHash,
    });
  }
  return events;
};

const buildConversationEvents = async (convId: string) => {
  const peer = peerContexts.get(convId);
  if (!peer?.friendKeyId || !peer.dhPub) return [];
  const logId = conversationsLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId);
  const legacyKey = await resolveLegacyKey(convId);
  if (!ratchetBaseKey || !legacyKey) return [];
  const identityPriv = await getIdentityPrivateKey();
  const deviceId = getOrCreateDeviceId();
  let nextLamport = perAuthorLamportSeen.get(deviceId) ?? 0;

  const conversations = await listConversations();
  const events: EnvelopeEvent[] = [];

  let prevHash = await getLastEventHash(logId);
  for (const conversation of conversations) {
    nextLamport += 1;
    const header: EnvelopeHeader = {
      v: 1 as const,
      eventId: createId(),
      convId: logId,
      ts: Date.now(),
      lamport: nextLamport,
      authorDeviceId: deviceId,
    };
    header.prev = prevHash;
    let keyForEnvelope = legacyKey;
    try {
      const ratchet = await nextSendDhKey(logId, ratchetBaseKey);
      header.rk = ratchet.headerRk;
      keyForEnvelope = ratchet.msgKey;
    } catch {
      try {
        const ratchet = await nextSendKey(logId, ratchetBaseKey);
        header.rk = ratchet.headerRk;
        keyForEnvelope = ratchet.msgKey;
      } catch (error) {
        console.warn("[ratchet] conversations send fallback to legacy", error);
      }
    }

    const envelope = await encryptEnvelope(
      keyForEnvelope,
      header,
      {
        type: "conv",
        conv: {
          id: conversation.id,
          type: conversation.type,
          name: conversation.name,
          pinned: conversation.pinned,
          unread: conversation.unread,
          hidden: conversation.hidden,
          muted: conversation.muted,
          blocked: conversation.blocked,
          pendingAcceptance: conversation.pendingAcceptance,
          lastTs: conversation.lastTs,
          lastMessage: conversation.lastMessage,
          participants: conversation.participants,
        },
      },
      identityPriv
    );
    const eventHash = await computeEnvelopeHash(envelope);
    events.push({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
    });
    prevHash = eventHash;
    updateLamportSeen(logId, header.authorDeviceId, header.lamport);
    await saveEvent({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
      prevHash: header.prev,
      eventHash,
    });
  }
  return events;
};

export const syncContactsNow = async () => {
  const activeConvs = Array.from(peerContexts.keys());
  for (const convId of activeConvs) {
    try {
      const peer = peerContexts.get(convId);
      if (peer?.kind !== "device") continue;
      const allowed = await isDeviceSyncAllowed(convId, "sync_contacts");
      if (!allowed) continue;
      const since = getSinceMap(contactsLogId(convId));
      const req: SyncReqFrame = {
        type: "SYNC_REQ",
        scope: "contacts",
        convId,
        since,
      };
      await sendFrame(convId, req);

      const events = await buildContactEvents(convId);
      if (!events.length) continue;
      const next = buildNextMap(events);
      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "contacts",
        convId,
        events,
        next,
      };
      await sendFrame(convId, frame);
    } catch (error) {
      console.warn("[sync] contacts sync failed", error);
    }
  }
};

export const syncConversationsNow = async () => {
  const activeConvs = Array.from(peerContexts.keys());
  for (const convId of activeConvs) {
    try {
      const peer = peerContexts.get(convId);
      if (peer?.kind !== "device") continue;
      const allowed = await isDeviceSyncAllowed(convId, "sync_conversations");
      if (!allowed) continue;
      const since = getSinceMap(conversationsLogId(convId));
      const req: SyncReqFrame = {
        type: "SYNC_REQ",
        scope: "conversations",
        convId,
        since,
      };
      await sendFrame(convId, req);

      const events = await buildConversationEvents(convId);
      if (!events.length) continue;
      const next = buildNextMap(events);
      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "conversations",
        convId,
        events,
        next,
      };
      await sendFrame(convId, frame);
    } catch (error) {
      console.warn("[sync] conversations sync failed", error);
    }
  }
};

export const __testApplyEnvelopeEvents = applyEnvelopeEvents;
export const __testSetPeerContext = (convId: string, peer: PeerContext) => {
  peerContexts.set(convId, peer);
};
export const __testResetSyncState = () => {
  perAuthorLamportSeen.clear();
  perConvLamportSeen.clear();
  peerContexts.clear();
};
