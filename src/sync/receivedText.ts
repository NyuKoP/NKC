import type { Envelope } from "../crypto/box";
import type { Conversation, Message } from "../db/repo";
import { listConversations, listProfiles } from "../db/repo";
import type { ReceiveContext } from "../accounts/receiveContext";
import { canonicalBytes } from "../crypto/canonicalJson";
import { getAccountRootIdentity, getAuthorizedDevice, getAuthorizedDeviceRegistry, verifyDeviceAuthorization, type DeviceAuthorization } from "../devices/deviceApprovals";
import { getIdentityPrivateKey } from "../security/identityKeys";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { getSodium } from "../security/sodium";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { createId } from "../utils/ids";
import { parseIncomingMediaRef } from "../security/mediaPolicy";

/** This inner proof can be re-encrypted for own devices; an endpoint ciphertext cannot. */
export type LogicalMessage = {
  v: 2;
  type: "account_message";
  id: string;
  conversationIdentity: string;
  senderAccountIdentity: string;
  recipientAccountIdentity: string;
  groupId?: string;
  author: DeviceAuthorization;
  ts: number;
  text: string;
  media?: Message["media"];
  sig: string;
};

export type LogicalRead = {
  groupId?: string;
  v: 2; type: "account_read"; id: string; conversationIdentity: string;
  readerAccountIdentity: string; peerAccountIdentity: string; anchorMsgId: string;
  cursorTs: number; ts: number; author: DeviceAuthorization; sig: string;
};

export type LogicalMediaChunk = {
  groupId?: string;
  v: 2; type: "account_media"; id: string; messageId: string; conversationIdentity: string;
  senderAccountIdentity: string; recipientAccountIdentity: string; author: DeviceAuthorization;
  idx: number; total: number; chunkSize: number; size: number; mime: string; chunkHash: string; ts: number; sig: string;
};

export type LogicalDelivered = {
  groupId?: string;
  v: 2; type: "account_delivered"; id: string; logicalMessageId: string; conversationIdentity: string;
  senderAccountIdentity: string; recipientAccountIdentity: string; author: DeviceAuthorization;
  targetEventId: string; targetEventHash: string; targetAuthorDeviceId: string; ts: number; sig: string;
};

/** Group authority comes from the existing GROUP v2 local mapping, never a claimed member list. */
export const resolveAccountGroup = async (groupId: string, context: ReceiveContext) => {
  if (typeof groupId !== "string" || !groupId || groupId.length > 128) return null;
  const root = await getAccountRootIdentity(context);
  const profiles = await listProfiles(context.vault);
  const users = profiles.filter(profile => profile.kind === "user");
  const conv = (await listConversations(context.vault)).find(item => item.id === groupId && item.type === "group" && !item.blocked && !item.hidden);

  if (!root || users.length !== 1 || !conv?.participants.includes(users[0].id)) return null;
  const members = new Map<string, string>();

  for (const id of conv.participants) {
    const matches = profiles.filter(profile => profile.id === id && (profile.kind === "user" ||
      profile.kind === "friend" && profile.friendStatus === "normal" && profile.trust?.status === "trusted" &&
      profile.verification?.status !== "key_changed"));

    if (matches.length !== 1) return null;
    const identity = matches[0].kind === "user" ? root : matches[0].identityPub;

    if (!identity || decodeBase64Url(identity).length !== 32 || members.has(identity)) return null;
    members.set(identity, id);
  }

  await context.vault.assertMain();

  return { conv, members, root, localUserId: users[0].id };
};

const validLogicalScope = async (value: { groupId?: string; conversationIdentity: string; senderAccountIdentity: string; recipientAccountIdentity: string },
  context: ReceiveContext) => {
  const root = await getAccountRootIdentity(context);

  if (value.groupId !== undefined) {
    const group = await resolveAccountGroup(value.groupId, context);

    return Boolean(group && value.conversationIdentity === value.groupId &&
      value.recipientAccountIdentity === value.groupId && group.members.has(value.senderAccountIdentity));
  }

  if (!root || ![value.senderAccountIdentity, value.recipientAccountIdentity].includes(root) ||
      value.conversationIdentity !== await logicalConversationIdentity(value.senderAccountIdentity, value.recipientAccountIdentity)) return false;
  await getAuthorizedDeviceRegistry(context, value.recipientAccountIdentity);

  return true;
};

const verifyLogicalAuthor = async (value: LogicalMessage | LogicalRead | LogicalMediaChunk | LogicalDelivered, root: string, context: ReceiveContext) => {
  if (!await getAuthorizedDevice(getOrCreateDeviceId(context), context)) return false;
  const current = (await getAuthorizedDeviceRegistry(context, root))[value.author.deviceId];

  if (!current || value.author.kind !== "DEVICE_ADDED" || !await verifyDeviceAuthorization(value.author, root) ||
      current.identityPub !== value.author.identityPub || current.dhPub !== value.author.dhPub ||
      value.author.epoch > current.epoch || value.ts < value.author.ts || value.ts >= value.author.expiresAt ||
      current.kind === "DEVICE_REVOKED" && (value.author.epoch >= current.epoch || value.ts >= current.ts)) return false;
  const { sig, ...payload } = value;
  const valid = (await getSodium()).crypto_sign_verify_detached(decodeBase64Url(sig), canonicalBytes(payload), decodeBase64Url(current.identityPub));
  await context.vault.assertMain();

  return valid;
};

export const createLogicalDelivered = async (message: LogicalMessage, envelope: Pick<Envelope, "header">, eventHash: string,
  context: ReceiveContext): Promise<LogicalDelivered> => {
  const author = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

  // GROUP own-device custody also needs proof; human delivery still excludes the sender account.
  if (!author || (!message.groupId && author.accountRootIdentityPub !== message.recipientAccountIdentity) ||
      !await verifyLogicalMessage(message, context)) {
    throw new Error("DELIVERED_ACTOR_MISMATCH");
  }

  const payload = { v: 2 as const, type: "account_delivered" as const, id: `delivered:${envelope.header.eventId}`,
    logicalMessageId: message.id, conversationIdentity: message.conversationIdentity,
    senderAccountIdentity: message.senderAccountIdentity, recipientAccountIdentity: author.accountRootIdentityPub, author,
    ...(message.groupId ? { groupId: message.groupId } : {}),
    targetEventId: envelope.header.eventId, targetEventHash: eventHash, targetAuthorDeviceId: envelope.header.authorDeviceId, ts: Date.now() };

  const proof = { ...payload, sig: encodeBase64Url((await getSodium()).crypto_sign_detached(canonicalBytes(payload), await getIdentityPrivateKey(context))) };

  if (!await verifyLogicalDelivered(proof, context)) throw new Error("DELIVERED_PROOF_INVALID");

  return proof;
};

export const verifyLogicalDelivered = async (proof: LogicalDelivered, context: ReceiveContext) => {
  try {
    const root = await getAccountRootIdentity(context);

    if (!root || proof?.v !== 2 || proof.type !== "account_delivered" ||
        ![proof.senderAccountIdentity, proof.recipientAccountIdentity].includes(root) ||
        typeof proof.logicalMessageId !== "string" || !proof.logicalMessageId || proof.logicalMessageId.length > 128 ||
        typeof proof.targetEventId !== "string" || !proof.targetEventId || proof.targetEventId.length > 128 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proof.targetAuthorDeviceId) ||
        proof.id !== `delivered:${proof.targetEventId}` || !/^[a-zA-Z0-9_-]{32,128}$/.test(proof.targetEventHash) ||
        !Number.isSafeInteger(proof.ts) || proof.ts > Date.now() + 5 * 60 * 1000 ||
        proof.author?.accountRootIdentityPub !== proof.recipientAccountIdentity ||
        (proof.groupId !== undefined ? proof.conversationIdentity !== proof.groupId ||
          !(await resolveAccountGroup(proof.groupId, context))?.members.has(proof.senderAccountIdentity) ||
          !(await resolveAccountGroup(proof.groupId, context))?.members.has(proof.recipientAccountIdentity) :
          proof.conversationIdentity !== await logicalConversationIdentity(proof.senderAccountIdentity, proof.recipientAccountIdentity))) return false;

    return await verifyLogicalAuthor(proof, proof.recipientAccountIdentity, context);
  } catch { return false; }
};

export const createLogicalMediaChunk = async (message: LogicalMessage, idx: number, bytes: Uint8Array,
  context: ReceiveContext): Promise<LogicalMediaChunk> => {
  const author = await getAuthorizedDevice(getOrCreateDeviceId(context), context);
  const media = parseIncomingMediaRef(message.media, message.id);

  if (!author || !media || message.author.deviceId !== author.deviceId || !await verifyLogicalMessage(message, context)) {
    throw new Error("MEDIA_AUTHOR_MISMATCH");
  }

  const payload = { v: 2 as const, type: "account_media" as const, id: `${message.id}:${idx}`, messageId: message.id,
    conversationIdentity: message.conversationIdentity, senderAccountIdentity: message.senderAccountIdentity,
    recipientAccountIdentity: message.recipientAccountIdentity, author, idx, total: media.total,
    ...(message.groupId ? { groupId: message.groupId } : {}),
    chunkSize: media.chunkSize, size: media.size, mime: media.mime,
    chunkHash: encodeBase64Url((await getSodium()).crypto_generichash(32, bytes)), ts: Date.now() };

  const proof = { ...payload, sig: encodeBase64Url((await getSodium()).crypto_sign_detached(canonicalBytes(payload), await getIdentityPrivateKey(context))) };

  if (!await verifyLogicalMediaChunk(proof, bytes, context)) throw new Error("MEDIA_CHUNK_INVALID");

  return proof;
};

export const verifyLogicalMediaChunk = async (proof: LogicalMediaChunk, bytes: Uint8Array, context: ReceiveContext) => {
  try {
    const root = await getAccountRootIdentity(context);
    const media = parseIncomingMediaRef({ ...proof, ownerType: "message", ownerId: proof.messageId, name: "chunk" }, proof.messageId);

    if (!root || proof?.v !== 2 || proof.type !== "account_media" || !media ||
        !await validLogicalScope(proof, context) ||
        typeof proof.messageId !== "string" || !proof.messageId || proof.messageId.length > 128 ||
        !Number.isInteger(proof.idx) || proof.idx < 0 || proof.idx >= proof.total || proof.id !== `${proof.messageId}:${proof.idx}` ||
        !Number.isSafeInteger(proof.ts) || proof.ts > Date.now() + 5 * 60 * 1000 ||
        bytes.length !== Math.min(proof.chunkSize, proof.size - proof.idx * proof.chunkSize) ||
        encodeBase64Url((await getSodium()).crypto_generichash(32, bytes)) !== proof.chunkHash ||
        proof.author?.accountRootIdentityPub !== proof.senderAccountIdentity) return false;

    return await verifyLogicalAuthor(proof, proof.senderAccountIdentity, context);
  } catch { return false; }
};

export const createLogicalRead = async (message: LogicalMessage, context: ReceiveContext): Promise<LogicalRead> => {
  const root = await getAccountRootIdentity(context);
  const author = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

  if (!root || !author || (message.groupId ? root === message.senderAccountIdentity : root !== message.recipientAccountIdentity) ||
      !await verifyLogicalMessage(message, context)) throw new Error("READ_ACTOR_MISMATCH");

  const payload = { v: 2 as const, type: "account_read" as const, id: createId(), author,
    readerAccountIdentity: root, peerAccountIdentity: message.senderAccountIdentity,
    conversationIdentity: message.conversationIdentity, anchorMsgId: message.id, cursorTs: message.ts, ts: Date.now() };

  const scopedPayload = { ...payload, ...(message.groupId ? { groupId: message.groupId } : {}) };
  const sig = encodeBase64Url((await getSodium()).crypto_sign_detached(canonicalBytes(scopedPayload), await getIdentityPrivateKey(context)));
  await context.vault.assertMain();

  return { ...scopedPayload, sig };
};

export const verifyLogicalRead = async (read: LogicalRead, context: ReceiveContext) => {
  try {
    const root = await getAccountRootIdentity(context);

    if (!root || read?.v !== 2 || read.type !== "account_read" ||
        (read.groupId === undefined && ![read.readerAccountIdentity, read.peerAccountIdentity].includes(root)) ||
        typeof read.id !== "string" || !read.id || read.id.length > 128 ||
        typeof read.anchorMsgId !== "string" || !read.anchorMsgId || read.anchorMsgId.length > 128 ||
        !Number.isSafeInteger(read.ts) || !Number.isSafeInteger(read.cursorTs) || read.cursorTs < 0 || read.cursorTs > read.ts ||
        read.ts > Date.now() + 5 * 60 * 1000 || read.author?.accountRootIdentityPub !== read.readerAccountIdentity ||
        (read.groupId !== undefined ? read.conversationIdentity !== read.groupId ||
          !(await resolveAccountGroup(read.groupId, context))?.members.has(read.readerAccountIdentity) ||
          !(await resolveAccountGroup(read.groupId, context))?.members.has(read.peerAccountIdentity) :
          read.conversationIdentity !== await logicalConversationIdentity(read.readerAccountIdentity, read.peerAccountIdentity))) return false;
    await getAuthorizedDeviceRegistry(context, read.peerAccountIdentity);

    return await verifyLogicalAuthor(read, read.readerAccountIdentity, context);
  } catch { return false; }
};

export const logicalConversationIdentity = async (first: string, second: string) => encodeBase64Url(
  (await getSodium()).crypto_generichash(32, canonicalBytes({ domain: "nkc-account-conversation-v2", members: [first, second].sort() })));

export const deviceChannelIdentity = (firstDeviceId: string, secondDeviceId: string) =>
  `device-sync:${[firstDeviceId, secondDeviceId].sort().join(":")}`;

/** Original logical ID stays constant, whereas each device receives its own immutable target. */
export const deviceDeliveryIdentity = async (logicalId: string, recipient: DeviceAuthorization, senderDeviceId: string) => encodeBase64Url(
  (await getSodium()).crypto_generichash(32, canonicalBytes({ domain: "nkc-device-delivery-v2", logicalId,
    senderDeviceId, accountIdentity: recipient.accountRootIdentityPub, deviceId: recipient.deviceId, identityPub: recipient.identityPub })));

export const createLogicalMessage = async (recipientAccountIdentity: string, text: string, context: ReceiveContext,
  input: { id?: string; media?: Message["media"]; groupId?: string } = {}): Promise<LogicalMessage> => {
  const root = await getAccountRootIdentity(context);
  const author = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

  if (!root || !author) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");

  if (input.groupId !== undefined ? recipientAccountIdentity !== input.groupId || !await resolveAccountGroup(input.groupId, context) :
      decodeBase64Url(recipientAccountIdentity).length !== 32 || encodeBase64Url(decodeBase64Url(recipientAccountIdentity)) !== recipientAccountIdentity) {
    throw new Error("ACCOUNT_IDENTITY_INVALID");
  }

  if (!input.groupId) await getAuthorizedDeviceRegistry(context, recipientAccountIdentity);
  const id = input.id ?? createId();

  if (!id || id.length > 128 || typeof text !== "string" ||
      input.media && !parseIncomingMediaRef(input.media, id)) throw new Error("LOGICAL_MESSAGE_INVALID");

  const payload = { v: 2 as const, type: "account_message" as const, id,
    conversationIdentity: input.groupId ?? await logicalConversationIdentity(root, recipientAccountIdentity),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    senderAccountIdentity: root, recipientAccountIdentity, author, ts: Date.now(), text,
    ...(input.media ? { media: input.media } : {}) };

  const sig = encodeBase64Url((await getSodium()).crypto_sign_detached(canonicalBytes(payload), await getIdentityPrivateKey(context)));
  await context.vault.assertMain();

  return { ...payload, sig };
};

export const verifyLogicalMessage = async (message: LogicalMessage, context: ReceiveContext) => {
  try {
    const ownRoot = await getAccountRootIdentity(context);

    if (!ownRoot || !message || message.v !== 2 || message.type !== "account_message" ||
        !await validLogicalScope(message, context) ||
        typeof message.id !== "string" || !message.id || message.id.length > 128 ||
        !Number.isSafeInteger(message.ts) || message.ts < 0 || typeof message.text !== "string" ||
        message.author?.accountRootIdentityPub !== message.senderAccountIdentity ||
        message.media && !parseIncomingMediaRef(message.media, message.id)) return false;

    return await verifyLogicalAuthor(message, message.senderAccountIdentity, context);
  } catch { return false; }
};

/** Shared message construction; guarded preview updates are opt-in. */
export const buildReceivedText = (
  conv: Conversation,
  envelope: Pick<Envelope, "header">,
  text: string,
  senderId: string,
  reconnectRequired = false,
  updatePreview = true,
) => ({
  message: { id: envelope.header.eventId, convId: conv.id, senderId, text, ts: envelope.header.ts } satisfies Message,
  conversation: {
    ...conv,
    hidden: reconnectRequired ? false : conv.hidden,
    blocked: reconnectRequired ? true : conv.blocked,
    pendingAcceptance: reconnectRequired ? false : conv.pendingAcceptance,
    pendingOutgoing: reconnectRequired ? false : conv.pendingOutgoing,
    pendingFriendResponse: reconnectRequired ? undefined : conv.pendingFriendResponse,
    lastMessage: updatePreview ? text : conv.lastMessage,
    lastTs: updatePreview ? envelope.header.ts : conv.lastTs,
    unread: reconnectRequired ? Math.max(1, conv.unread + 1) : conv.unread,
  } satisfies Conversation,
});
