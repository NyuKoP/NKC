import { isEnvelopeLike, isRawEnvelope, type IncomingEnvelope } from "../crypto/box";
import { legacyEventJson, legacyOutboxCiphertext, readEventEnvelope, sameOutboxPayload, samePayloadBytes } from "../storage/storedPayload";
import { decodeBinaryEnvelopeFrame, encodeBinaryEnvelopeFrame } from "../crypto/binaryEnvelope";
import { decodeBinaryTransportPacketV2 } from "../adapters/transports/packetCodec";
import type { EventRecord } from "../db/schema";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../net/mediaTransferLimits";
import { assertCurrentOutgoingSource } from "./outgoingSource";
import {
  computeEnvelopeHash,
  decryptEnvelope,
  deriveConversationKey,
  deriveConversationKeyPair,
  encryptEnvelope,
  type Envelope,
  type EnvelopeHeader,
  verifyEnvelopeSignature,
} from "../crypto/box";
import { canonicalBytes } from "../crypto/canonicalJson";
import { countSessionStage, countSessionReason } from "../diagnostics/sessionInvestigation";
import { advanceHistoryInventory, buildHistoryInventory, findHistoryInventory, HISTORY_MAX_ITEMS, historyBodyHash, loadHistoryInventory, readHistoryInventory, retainHistoryInventory, retainHistoryInventorySnapshot, storedHistoryDeliveries,
  type HistoryBinding, type HistoryInventory } from "./historyInventory";
import { agreeFreshSession, createSessionContribution, freshRatchetChannel, validateSessionContribution,
  confirmFreshSession, verifyFreshSessionConfirmation, matchesFreshSession,
  sameSessionIdentity, type SessionIdentity, type FriendSessionIdentity, type FreshSession, type SessionContribution } from "../crypto/freshSession";
import { sameCertificate } from "../devices/securityState";
import { getOutbox } from "../storage/outboxStore";
import { buildReceivedText, createLogicalMessage, verifyLogicalMessage, createLogicalRead, verifyLogicalRead, deviceChannelIdentity, deviceDeliveryIdentity, resolveAccountGroup,
  createLogicalMediaChunk, verifyLogicalMediaChunk, createLogicalDelivered, verifyLogicalDelivered,
  logicalConversationIdentity, type LogicalMessage, type LogicalRead, type LogicalMediaChunk, type LogicalDelivered } from "./receivedText";
import { decryptJsonRecord, encryptJsonRecord, decodeBinaryEnvelope, sameStoredCiphertext } from "../crypto/vault";
import { readMediaCustody } from "../storage/mediaCustody";
import { markMediaTransferStored } from "../storage/mediaTransferStore";
import { isUnifiedTextChannel, unifiedAppExperimentEnabled } from "./unifiedAppPolicy";
import { receiveUnifiedAppText } from "./unifiedAppRatchet";
import { nextSendDhKey, tryRecvDhKey, tryRecvKey } from "../crypto/ratchet";
import { nativeRatchetCasEnabled, hasReceiveCommit, acknowledgeReceiveCommit, hasSendCommit, acknowledgeSendCommit } from "../security/ratchetStore";
import { throwIfCryptoStorageFailure } from "../security/cryptoStorageErrors";
import type { DeliveryContext } from "../diagnostics/coldStartMetrics";
import { firstMessageMeasurement } from "../diagnostics/coldStartMetrics";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { computeVaultKeyId, onVaultKeyChange } from "../crypto/sessionKeyring";
import { getSecretStore } from "../security/secretStore";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import { sendCiphertext, sendOutboxRecord } from "../net/router";
import { computeExpiresAt } from "../policies/ttl";
import { writeVault } from "../db/vaultAccess";
import type { ReceiveContext } from "../accounts/receiveContext";
import { receiveSucceeded, type IncomingCompletion } from "./receiveCompletion";
import {
  getEvent,
  commitAuthenticatedText,
  commitAuthenticatedProfile,
  commitAuthenticatedGroup,
  type AuthenticatedProfileApplication,
  nextLamportForConv,
  retainAuthenticatedApplication,
  readAuthenticatedApplication,
  getLastEventHash,
  deleteConversationData,
  listConversations,
  listMessagesByConv,
  listEventsByConv,
  listProfiles,
  saveMessage,
  getStoredMessage,
  readMessageMediaChunks,
  markTextEventStored,
  saveReceivedMessageMediaChunk,
  saveConversation,
  saveEvent,
  saveProfile,
  saveProfilePhoto,
  loadProfilePhoto,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { parseIncomingMediaRef, isSafePreviewMime } from "../security/mediaPolicy";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getDhPrivateKey, getDhPublicKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import { getFriendPsk } from "../security/pskStore";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { applyTOFU, hasAuthenticatedFriendKeys } from "../security/trust";
import { computeFriendId, decodeFriendCodeV1 } from "../security/friendCode";
import { getPrivacyPrefs } from "../security/preferences";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { createSafeConsole } from "../diagnostics/safeConsole";
import { updateFromRoleEvent, commitAuthenticatedRoleEvent, captureDeviceRegistryContext, type RoleChangeEvent } from "../devices/deviceRegistry";
import { getAccountRootIdentity, getAuthorizedDevice, getAuthorizedDeviceRegistry, verifyDeviceAuthorization, readSignedDeviceRegistry, reconcileDeviceAuthorizations,
  getDeviceApproval, commitDeviceAuthorization, type DeviceAuthorization } from "../devices/deviceApprovals";
import { createId } from "../utils/ids";
import {
  connectConversation as connectTransport,
  disconnectConversation as disconnectTransport,
  onConversationMessage,
  sendToConversation,
} from "../net/transportManager";
import type { PeerHint } from "../net/transport";
import { sanitizeRoutingHints } from "../net/privacy";
import { putReadCursor, putLogicalDelivered } from "../storage/receiptStore";
import { applyAuthenticatedDeliveredReceipt, enqueueOutgoing, reconcileAcknowledgedNativeRetries } from "../policies/deliveryPolicy";
import { applyAuthenticatedMediaReceipt, mediaChunkBinding, readStoredMediaReceipt, type MediaStoredReceipt } from "../policies/mediaDeliveryPolicy";
import { applyGroupEvent, isGroupEventPayload, mapIncomingGroupEvent } from "./groupSync";
import { getSodium } from "../security/sodium";
import {
  isFriendControlFrame,
  isFriendControlFrameFresh,
  verifyFriendControlFrameSignature,
  verifyFriendControlFrameProtocol,
  type FriendControlFrame,
  type FriendRequestFrame,
  type FriendResponseFrame,
  type ProfileUpdateFrame,
} from "../friends/friendControlFrame";
import { isPresenceStatus } from "../profile/presence";

const console = createSafeConsole(globalThis.console);

const setReceiveCache = <T>(context: ReceiveContext | undefined, cache: Map<string, T>, key: string, value: T) => {
  context?.vault.assertLocal();

  return cache.set(key, value);
};

const deleteReceiveCache = <T>(context: ReceiveContext | undefined, cache: Map<string, T>, key: string) => {
  context?.vault.assertLocal();

  return cache.delete(key);
};

const ownerKey = (id: string, context?: ReceiveContext) => `${context?.owner.accountId ?? getActiveAccountId()}:${id}`;

const sessionKey = (id: string, context?: ReceiveContext) => `${ownerKey(id, context)}:${context?.owner.session.token ?? "fixture"}`;

const peerConversationIds = (context?: ReceiveContext) => {
  const prefix = ownerKey("", context);

  return Array.from(peerContexts.keys()).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
};

const friendControlLocks = new Map<string, Promise<void>>();

const pendingMediaChunks = new Map<string, Array<Record<string, unknown>>>();

const MAX_PENDING_MEDIA_CHUNKS = 32;

const receiveChains = new Map<string, Promise<void>>();

const syncTextStoredListeners = new Set<(accountId: string) => void>();

/** A post-commit UI signal, scoped to this renderer. It carries no message content. */
export const onAuthenticatedSyncTextStored = (listener: (accountId: string) => void) => {
  syncTextStoredListeners.add(listener);

  return () => { syncTextStoredListeners.delete(listener); };
};

const notifyAuthenticatedSyncTextStored = (accountId: string) => {
  if (getActiveAccountId() !== accountId) return;

  for (const listener of syncTextStoredListeners) {
    try { listener(accountId); }
    catch { console.warn("[sync] post-commit listener failed"); }
  }
};

/** Prevent duplicate receive work in one renderer. Durable cross-renderer admission is separate. */
const withReceiveChain = async <T>(accountId: string, convId: string, work: () => Promise<T>, context?: ReceiveContext) => {
  const key = `${accountId.length}:${accountId}${convId}`;
  const previous = receiveChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  receiveChains.set(key, tail);
  await previous.catch(() => {});

  try {
    if (context) await context.vault.assertMain();
    else if (getActiveAccountId() !== accountId) throw new Error("ACCOUNT_CHANGED_DURING_RECEIVE");

    return await work();
  } finally {
    release();

    if (receiveChains.get(key) === tail) receiveChains.delete(key);
  }
};

export type DirectEnvelopeOptions = {
  eventId?: string; persistEvent?: boolean; context?: ReceiveContext; v2Only?: boolean; reuseEvent?: boolean;
  originalTs?: number; historyRequestId?: string;
  sourceStamp?: string;
  cryptoContext?: { conversationKey: Uint8Array; ratchetBaseKey: Uint8Array; identityPrivateKey: Uint8Array };
  encryptor?: typeof encryptEnvelope; releaseBeforeRoute?: boolean;
  outboxRetention?: "standard" | "transient"; transferId?: string; chunkIndex?: number;
  binaryTransport?: boolean; allowDeferred?: boolean;
  deviceTarget?: DeviceAuthorization;
  routingDeps?: Parameters<typeof sendCiphertext>[1];
  prepareOnly?: boolean;
  queueOnly?: boolean;
};

type AccountProfile = { type: "account_profile"; v: 2; accountRootIdentity: string;
  profile: ProfileUpdateFrame["profile"]; ts: number };

const validAccountProfile = (value: AccountProfile) => {
  try {
    const profile = value?.profile;

    return value?.type === "account_profile" && value.v === 2 && Number.isSafeInteger(value.ts) && value.ts >= 0 &&
      value.ts <= Date.now() + HANDSHAKE_NONCE_TTL_MS && profile && typeof profile.displayName === "string" &&
      profile.displayName.trim().length > 0 && profile.displayName.length <= 80 && typeof profile.status === "string" &&
      profile.status.length <= 190 && (!profile.presence || isPresenceStatus(profile.presence.status) &&
        Number.isSafeInteger(profile.presence.updatedAt) && profile.presence.updatedAt <= Date.now() + HANDSHAKE_NONCE_TTL_MS) &&
      (!profile.avatar || typeof profile.avatar.mime === "string" && profile.avatar.mime.startsWith("image/") &&
        isSafePreviewMime(profile.avatar.mime) && typeof profile.avatar.data === "string" &&
        decodeBase64Url(profile.avatar.data).length > 0 && decodeBase64Url(profile.avatar.data).length <= 512 * 1024);
  } catch { return false; }
};

const groupTargetAllowed = async (groupId: string, target: DeviceAuthorization, partner: UserProfile, context: ReceiveContext) => {
  const group = await resolveAccountGroup(groupId, context);

  return Boolean(group && group.members.has(target.accountRootIdentityPub) && partner.identityPub && group.members.has(partner.identityPub));
};

const accountConversationTargets = async (conv: Conversation, partner: UserProfile, context: ReceiveContext) => {
  const group = conv.type === "group" ? await resolveAccountGroup(conv.id, context) : null;

  if (conv.type === "group" && !group) throw new Error("GROUP_MEMBER_UNMAPPED");
  const roots = group ? [...group.members.keys()] : [partner.identityPub!, (await getAccountRootIdentity(context))!];
  const registries = await Promise.all(roots.map(root => getAuthorizedDeviceRegistry(context, root)));

  if (registries.some(registry => !Object.values(registry).some(device => device.kind === "DEVICE_ADDED"))) throw new Error("RECIPIENT_DEVICES_UNKNOWN");

  return registries.flatMap(registry => Object.values(registry)).filter(device =>
    device.kind === "DEVICE_ADDED" && device.deviceId !== getOrCreateDeviceId(context));
};

/** Shared ordinary sender. Crypto/event ownership is captured before queued work starts. */
export const usesCertifiedDelivery = async (conv: Conversation, partner: UserProfile, context: ReceiveContext) => {
  if (!await getAccountRootIdentity(context)) return false;

  if (conv.type === "group") return true;

  if (!partner.identityPub) throw new Error("OWNER_PEER_MISMATCH");

  // Terminal certificates also keep this channel certified; revocation cannot downgrade it.
  return Object.keys(await getAuthorizedDeviceRegistry(context, partner.identityPub)).length > 0;
};

export const sendOwnedDirectEnvelope = async (
  conv: Conversation, partner: UserProfile, body: unknown, priority: "high" | "normal" = "high",
  options: DirectEnvelopeOptions = {},
  routing?: { toDeviceId?: string; route?: { torOnion?: string; inboxWriteToken?: string } },
) => {
  let context = options.context ?? await captureLocalOperationContext();
  const target = options.deviceTarget;

  if (!context) throw new Error("OWNER_REQUIRED");

  if (target) {
    if (!context) throw new Error("OWNER_REQUIRED");
    context = await captureDeviceRegistryContext(context);
    const approved = await getAuthorizedDevice(target.deviceId, context, target.accountRootIdentityPub);

    if (!approved?.route || encodeBase64Url(canonicalBytes(approved)) !== encodeBase64Url(canonicalBytes(target))) {
      throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
    }
  }

  const channelId = target ? deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId) : conv.id;
  const participant = target ?? await authenticatedFriendIdentity(channelId, context, partner);

  if (!target) options = { ...options, eventId: options.eventId ?? createId(), reuseEvent: true };

  const sourceStamp = options.prepareOnly && options.sourceStamp === undefined ? undefined
    : await assertCurrentOutgoingSource(conv.id, partner, body, context, options.sourceStamp);

  options = { ...options, sourceStamp };
  const bodyType = (body as { type?: string })?.type;

  let intent = (!target || options.eventId && ["account_message", "account_read", "account_profile", "account_media", "account_device"].includes(bodyType ?? "")) && !options.prepareOnly && options.persistEvent !== false
    ? await retainFreshIntent(conv, partner, body, priority, options, context) : undefined;

  freshSendStages.set(ownerKey(channelId, context), "fresh");
  const fresh = await ensureFreshOutboundSession(channelId, participant, context);
  freshSendStages.set(ownerKey(channelId, context), "chain");
  // A snapshot needs fresh ratchet order: old receipt wrappers can precede their message anchors.
  const wireIdentity = options.historyRequestId ? `history:${options.historyRequestId}:${options.eventId}` : options.eventId;
  const deliveryId = wireIdentity && fresh ? await sessionDeliveryId(wireIdentity, fresh) : options.eventId;

  if (!partner.dhPub || !partner.identityPub) throw new Error("Missing peer keys");

  if (context && options.cryptoContext && !options.context) throw new Error("OWNER_REQUIRED");
  const accountId = context?.owner.accountId ?? getActiveAccountId();

  const prepared = await withReceiveChain(accountId, channelId, async () => {
    if (sourceStamp !== undefined) await assertCurrentOutgoingSource(conv.id, partner, body, context, sourceStamp);

    if (context) {
      const authorizationBody = body as { type?: string; v?: number; authorization?: DeviceAuthorization };
      const authority = target && authorizationBody.type === "account_device" && authorizationBody.v === 2 ? authorizationBody.authorization : undefined;

      const linkedMetadata = Boolean(target && authorizationBody.v === 2 && ["contact", "conv", "account_profile"].includes(authorizationBody.type ?? "") &&
        target.accountRootIdentityPub === await getAccountRootIdentity(context));

      const ownedConversation = (await listConversations(context.vault)).find(item => item.id === conv.id);
      const ownedPartner = (await listProfiles(context.vault)).find(item => item.id === partner.id);

      if (!authority && !linkedMetadata && (!ownedConversation?.participants.includes(partner.id) || ownedPartner?.identityPub !== partner.identityPub ||
        ownedPartner?.dhPub !== partner.dhPub)) throw new Error("OWNER_PEER_MISMATCH");

      // A pasted code is not proof that its advertised DH key belongs to the identity owner.
      if (!target && (!hasAuthenticatedFriendKeys(ownedPartner) || ownedPartner?.friendStatus !== "normal" || ownedPartner.trust?.status === "blocked" ||
        ownedPartner.verification?.status === "key_changed")) throw new Error("FRIEND_AUTHENTICATION_REQUIRED");

      if (target) {
        const proof = body as LogicalMessage;
        const root = await getAccountRootIdentity(context);
        const receipt = body as { type?: string; kind?: string; msgId?: string; eventHash?: string; logicalMessageId?: string };
        const delivered = receipt.type === "rcpt" && receipt.kind === "delivered";
        const mediaStored = receipt.type === "rcpt" && receipt.kind === "media_stored";
        const read = body as LogicalRead;
        const storageProof = body as LogicalDelivered;
        const group = isGroupEventPayload(body);
        const accountProfile = body as AccountProfile;
        const media = body as { type?: string; v?: number; proof?: LogicalMediaChunk; b64?: string };
        const original = (delivered || mediaStored) && receipt.msgId ? await getEvent(receipt.msgId, context.vault) : null;
        const originalEnvelope = original ? JSON.parse(legacyEventJson(original)) as Envelope : null;

        if (accountProfile.type === "account_profile" ? !validAccountProfile(accountProfile) || accountProfile.accountRootIdentity !== root ||
          (target.accountRootIdentityPub !== root && target.accountRootIdentityPub !== partner.identityPub) :
          linkedMetadata ? !await validateLinkedMetadata(body, context) :
            authority ? !await verifyDeviceAuthorization(authority, authority.accountRootIdentityPub) ||
              (target.accountRootIdentityPub !== root && authority.accountRootIdentityPub !== root) ||
              encodeBase64Url(canonicalBytes((await getAuthorizedDeviceRegistry(context, authority.accountRootIdentityPub))[authority.deviceId])) !==
              encodeBase64Url(canonicalBytes(authority)) :
              group ? !root || !await mapIncomingGroupEvent(body, root, context) ||
                (target.accountRootIdentityPub !== root && target.accountRootIdentityPub !== partner.identityPub) :
                media.type === "account_media" ? media.v !== 2 || !media.proof || typeof media.b64 !== "string" ||
                  !await verifyLogicalMediaChunk(media.proof, decodeBase64Url(media.b64), context) ||
                  (media.proof.groupId ? !await groupTargetAllowed(media.proof.groupId, target, partner, context) :
                    (target.accountRootIdentityPub !== root && target.accountRootIdentityPub !== media.proof.recipientAccountIdentity) ||
                    partner.identityPub !== (media.proof.senderAccountIdentity === root ? media.proof.recipientAccountIdentity : media.proof.senderAccountIdentity)) :
                  read.type === "account_read" ? !await verifyLogicalRead(read, context) ||
                    (read.groupId ? !await groupTargetAllowed(read.groupId, target, partner, context) :
                      ![root, read.peerAccountIdentity, read.readerAccountIdentity].includes(target.accountRootIdentityPub) ||
                      partner.identityPub !== (read.readerAccountIdentity === root ? read.peerAccountIdentity : read.readerAccountIdentity)) :
                    storageProof.type === "account_delivered" ? !await verifyLogicalDelivered(storageProof, context) ||
                      ![storageProof.senderAccountIdentity, storageProof.recipientAccountIdentity].includes(target.accountRootIdentityPub) ||
                      (storageProof.groupId ? !await groupTargetAllowed(storageProof.groupId, target, partner, context) :
                        partner.identityPub !== (storageProof.senderAccountIdentity === root ? storageProof.recipientAccountIdentity : storageProof.senderAccountIdentity)) ||
                      (!options.prepareOnly && !await canAutomaticallySendDeliveredReceipt(channelId, context)) :
                      mediaStored ? !await canAutomaticallySendMediaStorageReceipt(channelId, context) || !original ||
                        originalEnvelope?.header.deviceDelivery?.author.identityPub !== target.identityPub ||
                        JSON.stringify(await readStoredMediaReceipt(original, context.vault)) !== JSON.stringify(body) :
                        delivered ? !await canAutomaticallySendDeliveredReceipt(channelId, context) || !original ||
                          original.applicationState !== "stored" || original.eventHash !== receipt.eventHash ||
                          original.logicalMessageId !== receipt.logicalMessageId || originalEnvelope?.header.deviceDelivery?.author.identityPub !== target.identityPub :
                          !await verifyLogicalMessage(proof, context) ||
                          (proof.groupId ? !await groupTargetAllowed(proof.groupId, target, partner, context) :
                            (target.accountRootIdentityPub !== root && target.accountRootIdentityPub !== proof.recipientAccountIdentity) ||
                            partner.identityPub !== (proof.senderAccountIdentity === root ? proof.recipientAccountIdentity : proof.senderAccountIdentity))) {
          throw new Error("LOGICAL_MESSAGE_BINDING_REJECTED");
        }
      }

      if (options.v2Only && !target && !await canAutomaticallySendDeliveredReceipt(conv.id, context)) throw new Error("AUTHENTICATED_V2_REQUIRED");
    }

    const durableText = Boolean(intent && !target && conv.type === "direct" && bodyType === "msg" &&
      !options.prepareOnly && options.persistEvent !== false &&
      getSecretStore(context.owner.session).conditionalWrites && !nativeRatchetCasEnabled());

    const admit = async (event: EventRecord) => {
      if (!intent) throw new Error("FRESH_INTENT_CONFLICT");
      const retainedIntent = intent;
      const profile = await context.vault.db.profiles.get(partner.id);
      const conversation = await context.vault.db.conversations.get(conv.id);

      if (!profile || !conversation) throw new Error("OUTGOING_SOURCE_CHANGED");
      const currentConversation = await decryptJsonRecord<Conversation>(context.vault.key, conversation.id, "conv", conversation.enc_b64);

      if (currentConversation.id !== conv.id || currentConversation.type !== "direct" || currentConversation.hidden || currentConversation.blocked) {
        throw new Error("OUTGOING_SOURCE_CHANGED");
      }

      const currentPartner = await decryptJsonRecord<UserProfile>(context.vault.key, profile.id, "profile", profile.enc_b64);

      if (currentPartner.id !== partner.id || currentPartner.kind !== "friend" || currentPartner.identityPub !== partner.identityPub ||
          currentPartner.dhPub !== partner.dhPub) throw new Error("OWNER_PEER_MISMATCH");
      await assertCurrentFriendSession(channelId, fresh.id, context);
      await assertCurrentOutgoingSource(conv.id, partner, body, context, sourceStamp);
      const value = await decryptJsonRecord<FreshIntent>(context.vault.key, retainedIntent.key, "fresh-intent", retainedIntent.value);

      if (!value.preparedSend) throw new Error("SEND_COMMIT_UNCONFIRMED");
      const now = Date.now();

      if (!samePayloadBytes(canonicalBytes(body), canonicalBytes(value.body))) throw new Error("FRESH_INTENT_CONFLICT");
      const admissionKey = context.vault.key;
      const keyId = await computeVaultKeyId(admissionKey);
      const admittedEvent = { ...event, outgoingBody_enc: await encryptJsonRecord(admissionKey, event.eventId, `outgoing:${event.eventHash}`, value.body) };

      const committed = await encryptJsonRecord(admissionKey, retainedIntent.key, "fresh-intent", {
        ...value, preparedSend: { ...value.preparedSend, admitted: true } });

      const destination = routing ?? { toDeviceId: currentPartner.routingHints?.deviceId ?? currentPartner.primaryDeviceId ?? currentPartner.deviceId,
        route: currentPartner.routingHints?.onionAddr ? { torOnion: currentPartner.routingHints.onionAddr } : undefined };

      const ciphertext = legacyEventJson(event);
      await enqueueOutgoing({ id: event.eventId, convId: channelId, ciphertext, priority,
        createdAtMs: now, expiresAtMs: computeExpiresAt(now), nextAttemptAtMs: now, attempts: 0, status: "pending",
        retention: options.outboxRetention ?? retainedIntent.outboxRetention ?? "standard",
        binaryTransport: options.binaryTransport ?? retainedIntent.binaryTransport,
        ownerAccountId: context.owner.accountId, recipientIdentityPub: partner.identityPub,
        toDeviceId: destination.toDeviceId, torOnion: destination.route?.torOnion }, context.vault, admittedEvent, {
          key: retainedIntent.key, expected: retainedIntent.value, committed, keyId,
          profileId: profile.id, profileCiphertext: profile.enc_b64,
          conversationId: conversation.id, conversationCiphertext: conversation.enc_b64,
          logicalId: options.eventId ?? event.eventId, alreadyAdmitted: value.preparedSend.admitted === true });
      intent = { ...retainedIntent, value: committed };
    };

    if (durableText && intent) {
      const retained = await decryptJsonRecord<FreshIntent>(context.vault.key, intent.key, "fresh-intent", intent.value);
      const staged = retained.preparedSend;

      if (staged) {
        if (staged.sessionId !== fresh.id) throw new Error("SEND_COMMIT_OLD_SESSION");
        const envelope: unknown = JSON.parse(legacyEventJson(staged.event));

        if (!isEnvelopeLike(envelope)) throw new Error("SEND_COMMIT_UNCONFIRMED");

        if (staged.sessionId !== fresh.id || envelope.header.eventId !== deliveryId || envelope.header.convId !== channelId ||
            envelope.header.friendSessionId !== fresh.id || envelope.header.authorDeviceId !== getOrCreateDeviceId(context) ||
            staged.event.eventId !== envelope.header.eventId || staged.event.convId !== envelope.header.convId ||
            staged.event.localConvId !== conv.id || staged.event.authorDeviceId !== envelope.header.authorDeviceId || staged.event.lamport !== envelope.header.lamport ||
            staged.event.ts !== envelope.header.ts || staged.event.prevHash !== envelope.header.prev ||
            staged.marker !== staged.event.eventHash || await computeEnvelopeHash(envelope) !== staged.marker ||
            staged.ratchetChannel !== freshRatchetChannel(channelId, fresh.id) ||
            !await verifyEnvelopeSignature(envelope, await getIdentityPublicKey(context))) throw new Error("SEND_COMMIT_UNCONFIRMED");
        const admitted = await getOutbox(staged.event.eventId, context.vault);

        if (staged.admitted && !admitted) throw new Error("SEND_COMMIT_TERMINAL");

        if (!admitted && !await hasSendCommit(staged.ratchetChannel, staged.marker, getSecretStore(context.owner.session))) {
          throw new Error("SEND_COMMIT_UNCONFIRMED");
        }

        await admit(staged.event);
        await protectRatchetOperation(channelId, context, () => acknowledgeSendCommit(staged.ratchetChannel, staged.marker, getSecretStore(context.owner.session)));

        return { header: envelope.header, envelopeJson: legacyEventJson(staged.event) };
      }
    }

    if (options.reuseEvent && deliveryId) {
      const saved = await getEvent(deliveryId, context?.vault);

      if (saved) {
        const envelope = JSON.parse(legacyEventJson(saved)) as Envelope;

        if (envelope.header.convId !== channelId || envelope.header.eventId !== deliveryId ||
          envelope.header.authorDeviceId !== getOrCreateDeviceId(context) || envelope.header.rk?.v !== 2 ||
          !await verifyEnvelopeSignature(envelope, await getIdentityPublicKey(context))) throw new Error("OWNER_EVENT_MISMATCH");

        return { header: envelope.header, envelopeJson: legacyEventJson(saved) };
      }
    }

    if (options.originalTs !== undefined && (!Number.isSafeInteger(options.originalTs) || options.originalTs < 0 || options.originalTs > Date.now()))
      throw new Error("INVALID_HISTORY_TIMESTAMP");

    const header: EnvelopeHeader = { v: 1, eventId: deliveryId ?? createId(), convId: channelId,
      ts: options.originalTs ?? Date.now(), lamport: await nextLamportForConv(channelId, context?.vault), authorDeviceId: getOrCreateDeviceId(context) };

    if (target && context) {
      const author = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

      if (!author) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
      header.deviceDelivery = { v: 2, recipientDeviceId: target.deviceId, author, sessionId: fresh!.id,
        ...(options.eventId ? { deliveryId: options.eventId } : {}) };
    }

    if (!target) { header.friendSessionId = fresh.id;

      if (options.eventId) header.friendDeliveryId = options.eventId; }

    header.prev = await getLastEventHash(channelId, context?.vault);
    let cryptoContext = options.cryptoContext;

    if (!cryptoContext) {
      const friendKeyId = partner.friendId ?? partner.id;

      const keys = await deriveConversationKeyPair(await getDhPrivateKey(context), decodeBase64Url(target?.dhPub ?? partner.dhPub!),
        target ? null : await getFriendPsk(friendKeyId, context), textEncoder.encode(`direct:${friendKeyId}`),
        textEncoder.encode(target ? `certified-device-v2:${channelId}` : `conv:${conv.id}`));

      cryptoContext = { ...keys, identityPrivateKey: await getIdentityPrivateKey(context) };
    }

    const store = context ? getSecretStore(context.owner.session) : undefined;
    const ratchetChannel = fresh ? freshRatchetChannel(channelId, fresh.id) : channelId;

    if (target) await assertCurrentDeviceSession(channelId, fresh.id, target, context);
    else await assertCurrentFriendSession(channelId, fresh.id, context);
    const ratchetKey = fresh ? fresh.key.slice() : cryptoContext.ratchetBaseKey;

    let event: EventRecord | undefined;
    let result: { header: EnvelopeHeader; envelopeJson: string } | undefined;
    const signingKey = cryptoContext.identityPrivateKey;

    const prepare = async (key: Uint8Array, rk: NonNullable<EnvelopeHeader["rk"]>) => {
      header.rk = rk;
      freshSendStages.set(ownerKey(channelId, context), "encryption");
      const envelope = await (options.encryptor ?? encryptEnvelope)(key, header, body, signingKey);
      const envelopeJson = JSON.stringify(envelope);
      const eventHash = await computeEnvelopeHash(envelope);

      const outgoingBody_enc = !durableText && options.persistEvent !== false
        ? await encryptJsonRecord(context.vault.key, header.eventId, `outgoing:${eventHash}`, body) : undefined;

      if (target) await assertCurrentDeviceSession(channelId, fresh.id, target, context);
      else await assertCurrentFriendSession(channelId, fresh.id, context);

      if (sourceStamp !== undefined) await assertCurrentOutgoingSource(conv.id, partner, body, context, sourceStamp);
      event = { eventId: header.eventId, convId: header.convId,
      authorDeviceId: header.authorDeviceId, lamport: header.lamport, ts: header.ts, envelopeJson,
      prevHash: header.prev, eventHash, ...(sourceStamp !== undefined ? { outgoingSourceStamp: sourceStamp, outgoingPartnerId: partner.id } : {}),
      ...(context ? { localConvId: conv.id, outgoingBody_enc } : {}),
      ...(await mediaChunkBinding(body) ? { ephemeralApplication: true } : {}),
      ...(target && (body as LogicalMessage).type === "account_message" ? { logicalMessageId: (body as LogicalMessage).id } : {}) };
      result = { header, envelopeJson };

      if (durableText && intent) {
        const intentKey = intent.key;
        const previous = intent.value;
        const value = await decryptJsonRecord<FreshIntent>(context.vault.key, intent.key, "fresh-intent", previous);

        if (value.preparedSend) throw new Error("FRESH_INTENT_CONFLICT");
        const keyId = await computeVaultKeyId(context.vault.key);

        const encrypted = await encryptJsonRecord(context.vault.key, intent.key, "fresh-intent", { ...value,
          preparedSend: { event, sessionId: fresh.id, ratchetChannel, marker: eventHash } });

        await writeVault(context.vault, [context.vault.db.meta], async () => {
          const storedKeyId = (await context.vault.db.meta.get("vault_key_id_v1"))?.value;

          if (storedKeyId && storedKeyId !== keyId) throw new Error("OWNER_SESSION_CHANGED");

          if ((await context.vault.db.meta.get(intentKey))?.value !== previous) throw new Error("FRESH_INTENT_CONFLICT");
          await context.vault.db.meta.put({ key: intentKey, value: encrypted });
        });
        intent = { ...intent, value: encrypted };
      }

      return eventHash;
    };

    try {
      const sent = await protectRatchetOperation(channelId, context, () => nextSendDhKey(ratchetChannel, ratchetKey, store,
        durableText ? candidate => prepare(candidate.msgKey, candidate.headerRk) : undefined));

      if (!durableText) await prepare(sent.msgKey, sent.headerRk);
    } finally { ratchetKey.fill(0); }

    if (!result || !event) throw new Error("SEND_COMMIT_UNCONFIRMED");

    if (durableText) {
      await admit(event);
      const committedHash = event.eventHash;
      await protectRatchetOperation(channelId, context, () => acknowledgeSendCommit(ratchetChannel, committedHash, getSecretStore(context.owner.session)));
    } else if (options.persistEvent !== false) await saveEvent(event, context.vault);
    await context.vault.assertMain();

    return result;
  }, context);

  if (target) await assertCurrentDeviceSession(channelId, prepared.header.deviceDelivery?.sessionId, target, context);
  else await assertCurrentFriendSession(channelId, prepared.header.friendSessionId, context);
  freshSendStages.set(ownerKey(channelId, context), "route");
  const hints = partner.routingHints;

  if (options.prepareOnly) return prepared;

  const pending = await getOutbox(prepared.header.eventId, context.vault) ??
    (intent?.preparedEventId ? await getOutbox(intent.preparedEventId, context.vault) : undefined);
  if (pending && (pending.ownerAccountId !== context.owner.accountId || pending.convId !== channelId ||
      pending.recipientIdentityPub !== (target?.identityPub ?? partner.identityPub) ||
      pending.transferId !== options.transferId || pending.chunkIndex !== options.chunkIndex)) throw new Error("OWNER_OUTBOX_MISMATCH");
  // An admitted row (even in the prior session) owns absent legacy fields as well as explicit ones.
  const binaryTransport = options.binaryTransport ?? (pending ? pending.binaryTransport : intent?.binaryTransport);
  const outboxRetention = options.outboxRetention ?? (pending ? pending.retention : intent?.outboxRetention);

  // Local GROUP creation waits for durable custody, not transport readiness.
  if (options.queueOnly) {
    if (!context) throw new Error("OWNER_REQUIRED");

    const destination = target ? { toDeviceId: target.deviceId, route: { torOnion: target.route!.onionAddr } }
      : routing ?? { toDeviceId: hints?.deviceId ?? partner.primaryDeviceId ?? partner.deviceId,
        route: hints?.onionAddr ? { torOnion: hints.onionAddr } : undefined };

    const now = Date.now();
    await enqueueOutgoing({ id: prepared.header.eventId, convId: channelId, ciphertext: prepared.envelopeJson,
      priority, createdAtMs: now, expiresAtMs: computeExpiresAt(now), nextAttemptAtMs: now,
      attempts: 0, status: "pending", retention: outboxRetention ?? "standard",
      binaryTransport,
      ...(options.transferId ? { transferId: options.transferId, chunkIndex: options.chunkIndex } : {}),
      ownerAccountId: context.owner.accountId, recipientIdentityPub: target?.identityPub ?? partner.identityPub,
      toDeviceId: destination.toDeviceId, torOnion: destination.route?.torOnion }, context.vault);

    if (intent) await retireFreshIntent(intent, prepared, context);

    return prepared;
  }

  const routed = await sendCiphertext({ convId: channelId, messageId: prepared.header.eventId, ciphertext: prepared.envelopeJson,
    priority, access: context?.vault, recipientIdentityPub: target?.identityPub ?? partner.identityPub,
    outboxRetention, transferId: options.transferId, chunkIndex: options.chunkIndex,
    binaryTransport,
    ...(target ? { toDeviceId: target.deviceId, route: { torOnion: target.route!.onionAddr, inboxWriteToken: target.route!.inboxWriteToken } } : routing ?? { toDeviceId: hints?.deviceId ?? partner.primaryDeviceId ?? partner.deviceId,
      route: hints?.onionAddr ? { torOnion: hints.onionAddr, inboxWriteToken: hints.inboxWriteToken } : undefined }) }, options.routingDeps);

  if (!routed.ok && (!options.allowDeferred || !routed.error?.startsWith("RETRYABLE_SEND_FAILURE:"))) {
    throw new Error(routed.error ?? "Failed to route message");
  }

  if (intent) await retireFreshIntent(intent, prepared, context);

  return prepared;
};

/** One proof, separate ordinary Ratchet envelopes and immutable Outbox targets. */
export const sendAccountMessage = async (conv: Conversation, partner: UserProfile, text: string,
  options: { id?: string; media?: Message["media"]; clientBatchId?: string; context?: ReceiveContext; routingDeps?: DirectEnvelopeOptions["routingDeps"] } = {}) => {
  const captured = options.context ?? await captureLocalOperationContext();

  if (!captured || !partner.identityPub) throw new Error("ACCOUNT_ROOT_UNCONFIRMED");
  const context = await captureDeviceRegistryContext(captured);
  const existing = options.id ? await getStoredMessage(options.id, context.vault) : null;
  const recipientIdentity = conv.type === "group" ? conv.id : partner.identityPub;

  const proof = existing?.logicalProof ?? await createLogicalMessage(recipientIdentity, text, context,
    { ...options, ...(conv.type === "group" ? { groupId: conv.id } : {}) });

  if (existing && (!existing.logicalProof || existing.convId !== conv.id || proof.text !== text ||
    proof.recipientAccountIdentity !== recipientIdentity || proof.groupId !== (conv.type === "group" ? conv.id : undefined) ||
    JSON.stringify(proof.media) !== JSON.stringify(options.media) || !await verifyLogicalMessage(proof, context))) {
    throw new Error("LOGICAL_MESSAGE_CONFLICT");
  }

  const targets = await accountConversationTargets(conv, partner, context);

  if (targets.some(target => !target.route)) throw new Error("DEVICE_ROUTE_UNAVAILABLE");
  const localUser = await resolveLocalUserId(context);
  const currentConv = (await listConversations(context.vault)).find(item => item.id === conv.id);

  if (!localUser || !currentConv?.participants.includes(localUser) || !currentConv.participants.includes(partner.id)) {
    throw new Error("OWNER_PEER_MISMATCH");
  }

  if (!existing) await saveMessage({ id: proof.id, convId: conv.id, senderId: localUser, ts: proof.ts,
    text, media: proof.media, clientBatchId: options.clientBatchId, logicalProof: proof }, context.vault);
  await saveConversation({ ...currentConv, lastMessage: text, lastTs: Math.max(currentConv.lastTs, proof.ts), unread: 0 }, context.vault);

  // Each endpoint keeps its own pending intent; an offline handshake must not block online peers.
  const prepared = await Promise.allSettled(targets.map(async target =>
    sendOwnedDirectEnvelope(conv, partner, proof, "high", { context, deviceTarget: target,
      eventId: await deviceDeliveryIdentity(proof.id, target, getOrCreateDeviceId(context)), reuseEvent: true, v2Only: true, allowDeferred: true,
      routingDeps: options.routingDeps })));

  const deliveries = [];

  for (const result of prepared) {
    if (result.status === "rejected") throw result.reason;
    deliveries.push(result.value);
  }

  return { proof, deliveries };
};

export const sendAccountRead = async (conv: Conversation, partner: UserProfile, messageId: string, captured?: ReceiveContext) => {
  captured ??= await captureLocalOperationContext();

  if (!captured) throw new Error("OWNER_REQUIRED");
  const context = await captureDeviceRegistryContext(captured);
  const message = await getStoredMessage(messageId, context.vault);

  if (!message?.logicalProof || message.convId !== conv.id || !partner.identityPub) throw new Error("READ_CURSOR_TARGET_MISMATCH");
  const localUserId = await resolveLocalUserId(context);
  const previous = localUserId ? await context.vault.db.receipts.get(`read_cursor:${conv.id}:${localUserId}`) : undefined;
  const previousProof = previous?.logicalRead_enc ? await decryptJsonRecord<LogicalRead>(context.vault.key, previous.id, "receipt", previous.logicalRead_enc) : undefined;

  const proof = previousProof && previousProof.anchorMsgId === messageId && previousProof.cursorTs === message.ts &&
    await verifyLogicalRead(previousProof, context) ? previousProof : await createLogicalRead(message.logicalProof, context);

  if (!localUserId || proof.peerAccountIdentity !== partner.identityPub) throw new Error("READ_ACTOR_MISMATCH");
  await putReadCursor({ convId: conv.id, actorId: localUserId, cursorTs: proof.cursorTs,
    anchorMsgId: messageId, logicalRead: proof }, context.vault);
  const targets = await accountConversationTargets(conv, partner, context);

  const attempts = await Promise.allSettled(targets.map(async target => sendOwnedDirectEnvelope(conv, partner, proof, "normal", {
    context, deviceTarget: target, eventId: await deviceDeliveryIdentity(proof.id, target, getOrCreateDeviceId(context)),
    v2Only: true, allowDeferred: true, reuseEvent: true })));

  const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

  if (failures.length) throw new AggregateError(failures.map(attempt => attempt.reason), "READ_PUBLICATION_INCOMPLETE");

  return proof;
};

/** Account metadata uses the same certified envelopes and existing profile commit as history. */
export const sendAccountProfile = async (source: UserProfile, profile: ProfileUpdateFrame["profile"], captured: ReceiveContext,
  routingDeps?: DirectEnvelopeOptions["routingDeps"]) => {
  const context = await captureDeviceRegistryContext(captured);
  const root = await getAccountRootIdentity(context);
  const profiles = await listProfiles(context.vault);
  const users = profiles.filter(item => item.kind === "user" && item.id === source.id);

  if (!root || users.length !== 1) throw new Error("OWNER_PROFILE_MISMATCH");

  if (users[0].displayName !== profile.displayName || users[0].status !== profile.status ||
    users[0].updatedAt !== source.updatedAt || JSON.stringify(users[0].avatarRef) !== JSON.stringify(source.avatarRef)) {
    throw new Error("OWNER_PROFILE_CHANGED");
  }

  const body: AccountProfile = { type: "account_profile", v: 2, accountRootIdentity: root,
    profile, ts: Math.max(Number(users[0].profileUpdatedAt ?? 0), Number(users[0].updatedAt ?? users[0].createdAt ?? 0)) };

  if (!validAccountProfile(body)) throw new Error("PROFILE_APPLICATION_REJECTED");
  const id = `profile:${encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(body)))}`;
  const conversations = await listConversations(context.vault);
  const jobs: Array<() => Promise<unknown>> = [];

  for (const partner of profiles.filter(item => item.kind === "friend" && item.friendStatus === "normal" &&
    item.identityPub && item.dhPub && item.trust?.status === "trusted")) {
    const conv = conversations.find(item => item.type !== "group" && item.participants.includes(partner.id));

    if (!conv) continue;

    const targets = [...Object.values(await getAuthorizedDeviceRegistry(context, partner.identityPub)),
    ...Object.values(await getAuthorizedDeviceRegistry(context))].filter(target => target.kind === "DEVICE_ADDED" &&
      target.deviceId !== getOrCreateDeviceId(context));

    for (const target of targets) jobs.push(async () => sendOwnedDirectEnvelope(conv, partner, body, "normal", {
      context, deviceTarget: target, eventId: await deviceDeliveryIdentity(id, target, getOrCreateDeviceId(context)),
      v2Only: true, allowDeferred: true, reuseEvent: true, routingDeps }));
  }

  const attempts = await Promise.allSettled(jobs.map(send => send()));
  const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

  if (failures.length) throw new AggregateError(failures.map(attempt => attempt.reason), "PROFILE_PUBLICATION_INCOMPLETE");
};

/** Preserve the original signed chunk proof for independently authenticated live deliveries. */
export const sendAccountMediaChunk = async (conv: Conversation, partner: UserProfile, messageId: string, idx: number,
  bytes: Uint8Array, captured?: ReceiveContext,
  options: { target?: DeviceAuthorization; prepareOnly?: boolean; queueOnly?: boolean; routingDeps?: DirectEnvelopeOptions["routingDeps"] } = {}) => {
  captured ??= await captureLocalOperationContext();

  if (!captured || !partner.identityPub) throw new Error("OWNER_REQUIRED");
  const context = await captureDeviceRegistryContext(captured);
  const message = await getStoredMessage(messageId, context.vault);
  const id = `${messageId}:${idx}`;
  const chunk = await context.vault.db.mediaChunks.get(id);

  if (!message?.logicalProof || message.convId !== conv.id || (chunk && chunk.ownerType !== "message")) throw new Error("MEDIA_MANIFEST_UNAVAILABLE");
  const custody = !chunk ? await readMediaCustody(messageId, context.vault.db, context.vault.key) : undefined;

  if (chunk) {
    const stored = new Uint8Array(await decodeBinaryEnvelope(context.vault.key, id, "mediaChunk", chunk.enc_b64));

    if (stored.length !== bytes.length || !stored.every((byte, index) => byte === bytes[index])) throw new Error("MEDIA_CHUNK_CONFLICT");
  } else if (custody?.phase !== "plaintext" || !custody.proofs?.[idx]) throw new Error("MEDIA_MANIFEST_UNAVAILABLE");

  const proof = chunk?.logicalProof_enc ? await decryptJsonRecord<LogicalMediaChunk>(context.vault.key, id, "media-proof", chunk.logicalProof_enc) :
    custody?.proofs?.[idx] ?? await createLogicalMediaChunk(message.logicalProof, idx, bytes, context);

  if (!await verifyLogicalMediaChunk(proof, bytes, context)) throw new Error("MEDIA_CHUNK_INVALID");

  if (chunk && !chunk.logicalProof_enc) {
    const logicalProof_enc = await encryptJsonRecord(context.vault.key, id, "media-proof", proof);
    await writeVault(context.vault, [context.vault.db.mediaChunks], async () => {
      if (JSON.stringify(await context.vault.db.mediaChunks.get(id)) !== JSON.stringify(chunk)) throw new Error("MEDIA_CHUNK_CONFLICT");
      await context.vault.db.mediaChunks.update(id, { logicalProof_enc });
    });
  }

  const root = await getAccountRootIdentity(context);
  const targets = options.target ? [options.target] : await accountConversationTargets(conv, partner, context);

  const attempts = await Promise.allSettled(targets.filter(target => target.kind === "DEVICE_ADDED" &&
    target.deviceId !== getOrCreateDeviceId(context)).map(async target => {
      if (proof.groupId ? !await groupTargetAllowed(proof.groupId, target, partner, context) :
        target.accountRootIdentityPub !== root && target.accountRootIdentityPub !== proof.recipientAccountIdentity) throw new Error("MEDIA_OWNER_MISMATCH");

      return sendOwnedDirectEnvelope(conv, partner, { type: "account_media", v: 2, proof, b64: encodeBase64Url(bytes) }, "normal", {
        context, deviceTarget: target, eventId: await deviceDeliveryIdentity(proof.id, target, getOrCreateDeviceId(context)),
        reuseEvent: true, v2Only: true, allowDeferred: true, prepareOnly: options.prepareOnly, queueOnly: options.queueOnly,
        transferId: messageId, chunkIndex: idx, routingDeps: options.routingDeps });
    }));

  const results = [];

  for (const attempt of attempts) if (attempt.status === "fulfilled") results.push(attempt.value);
  const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

  if (failures.length) throw new AggregateError(failures.map(attempt => attempt.reason), "MEDIA_PUBLICATION_INCOMPLETE");

  return { proof, deliveries: results };
};

/** Account authority uses the existing device channel; it creates no human conversation/profile row. */
export const publishDeviceAuthorization = async (event: DeviceAuthorization, captured?: ReceiveContext,
  options: { target?: DeviceAuthorization; prepareOnly?: boolean; routingDeps?: DirectEnvelopeOptions["routingDeps"] } = {}) => {
  captured ??= await captureLocalOperationContext();

  if (!captured) throw new Error("OWNER_REQUIRED");
  const context = await captureDeviceRegistryContext(captured);
  const root = await getAccountRootIdentity(context);

  if (!root || !await getAuthorizedDevice(getOrCreateDeviceId(context), context)) throw new Error("DEVICE_AUTHORITY_REVOKED");
  const profiles = await listProfiles(context.vault);

  const roots = [root, ...profiles.filter(profile => profile.kind === "friend" && profile.identityPub &&
    profile.friendStatus === "normal" && profile.trust?.status === "trusted").map(profile => profile.identityPub!)];

  const targets = options.target ? [options.target] : (await Promise.all([...new Set(roots)]
    .map(identity => getAuthorizedDeviceRegistry(context, identity)))).flatMap(registry => Object.values(registry));

  const eventHash = encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(event)));

  // A failed/offline peer must not prevent other current peers from learning a revoke.
  const attempts = await Promise.allSettled(targets.filter(target => target.kind === "DEVICE_ADDED" &&
    target.deviceId !== getOrCreateDeviceId(context)).map(async target => {
      const channelId = deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId);

      const partner: UserProfile = { id: target.deviceId, kind: "friend", displayName: "", status: "", theme: "dark",
        identityPub: target.accountRootIdentityPub, dhPub: target.dhPub };

      const conv: Conversation = { id: channelId, participants: [], name: "", pinned: false, unread: 0,
        hidden: false, muted: false, blocked: false, lastTs: 0, lastMessage: "" };

      return sendOwnedDirectEnvelope(conv, partner, { type: "account_device", v: 2, authorization: event }, "high", {
        context, deviceTarget: target, eventId: await deviceDeliveryIdentity(`device-auth:${eventHash}`, target, getOrCreateDeviceId(context)),
        reuseEvent: true, v2Only: true, allowDeferred: true, prepareOnly: options.prepareOnly, routingDeps: options.routingDeps });
    }));

  const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

  if (failures.length) throw new AggregateError(failures.map(attempt => attempt.reason), "DEVICE_AUTHORIZATION_PUBLICATION_INCOMPLETE");

  return attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof sendOwnedDirectEnvelope>>> =>
    attempt.status === "fulfilled").map(attempt => attempt.value);
};

const withFriendControlLock = async <T>(identityPub: string, work: () => Promise<T>) => {
  const previous = friendControlLocks.get(identityPub) ?? Promise.resolve();
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.catch(() => {}).then(() => gate);
  friendControlLocks.set(identityPub, queued);
  countSessionStage("lock", "input");
  await previous.catch(() => {});
  countSessionStage("lock", "success");

  try {
    return await work();
  } finally {
    release();

    if (friendControlLocks.get(identityPub) === queued) {
      friendControlLocks.delete(identityPub);
    }
  }
};

type EnvelopeEvent = {
  eventId: string;
  convId: string;
  authorDeviceId: string;
  lamport: number;
  ts: number;
} & ({ envelopeJson: string; envelopeFormat?: undefined } | Extract<EventRecord, { envelopeFormat: "nkce-v1" }>);

type PeerCaps = {
  proto: number;
  sync: { v: number; inventory?: number };
  ratchet?: { v: number };
  media?: { chunks?: boolean; v?: number; storedReceipts?: boolean };
  devices?: { roles?: boolean; v?: number };
  binary?: { envelope: number; packet: number; text: number; media: number; retry: number };
};

type NormalizedPeerCaps = {
  proto: number;
  sync: { v: number; inventory?: number };
  ratchet: { v: number };
  media: { chunks: boolean; v: number; storedReceipts?: boolean };
  devices: { roles: boolean; v: number };
  binary?: NonNullable<PeerCaps["binary"]>;
};

const LEGACY_PEER_CAPS: NormalizedPeerCaps = {
  proto: 1,
  sync: { v: 1 },
  ratchet: { v: 0 },
  media: { chunks: false, v: 0, storedReceipts: false },
  devices: { roles: false, v: 0 },
};

const LOCAL_CAPS: PeerCaps = {
  proto: 1,
  sync: { v: 2, inventory: 1 },
  ratchet: { v: 2 },
  media: { chunks: true, v: 2, storedReceipts: true },
  devices: { roles: true, v: 1 },
};

type HelloFrame = {
  type: "HELLO";
  deviceId: string;
  identityPub: string;
  nonce: string;
  sig: string;
  caps?: PeerCaps;
  session?: SessionContribution;
  securityState?: DeviceAuthorization[];
  profile?: { displayName?: string; status?: string; avatarRef?: UserProfile["avatarRef"] };
};

type AckFrame = {
  type: "ACK";
  deviceId: string;
  identityPub: string;
  nonce: string;
  sig: string;
  caps?: PeerCaps;
  session?: SessionContribution;
  offer?: SessionContribution;
  keyConfirmation?: string;
  securityState?: DeviceAuthorization[];
};

type SyncReqFrame = {
  type: "SYNC_REQ";
  scope: "conv" | "contacts" | "conversations" | "global";
  convId?: string;
  since: Record<string, number>;
  history?: { v: 2; policy: "ALL" | "LAST_30_DAYS" | "NEW_ONLY"; fromTs: number };
  knownEventIds?: string[];
  inventoryVersion?: 1;
  resumeInventory?: { requestId: string; snapshotId: string };
};

type SyncResFrame = {
  type: "SYNC_RES";
  scope: "conv" | "contacts" | "conversations" | "global";
  convId?: string;
  events: EnvelopeEvent[];
  next: Record<string, number>;
  replyTo?: string;
  inventory?: HistoryInventory;
  flow?: {
    sessionId: string;
    chunkIndex: number;
    totalChunks: number;
    final: boolean;
  };
};

type SyncFlowAckFrame = {
  type: "SYNC_FLOW_ACK";
  sessionId: string;
  chunkIndex: number;
  receivedEvents: number;
};

type SessionReadyFrame = { type: "SESSION_READY"; sessionId: string; keyConfirmation: string };

type ControlAuthentication = {
  deviceDelivery?: EnvelopeHeader["deviceDelivery"];
  controlVersion: 2; identityPub: string; deviceId: string; recipientIdentityPub: string;
  controlNonce: string; controlTs: number; sig: string; replyTo?: string; convId?: string;
};

type Frame = (HelloFrame | AckFrame | SessionReadyFrame | SyncReqFrame | SyncResFrame | SyncFlowAckFrame) & Partial<ControlAuthentication>;

export type PeerContext = PeerHint & {
  accountRootIdentity?: string;
  friendKeyId?: string;
  identityPub?: string;
  dhPub?: string;
  peerCaps?: NormalizedPeerCaps;
  authenticatedCapsToken?: string;
};

const contactsLogId = (convId: string) => `contacts:${convId}`;

const conversationsLogId = (convId: string) => `convs:${convId}`;

const globalLogId = (convId: string) => `global:${convId}`;

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

type SyncTransportOverride = {
  send: (convId: string, bytes: Uint8Array) => Promise<void> | void;
};

let syncTransportOverride: SyncTransportOverride | null = null;

const MAX_SYNC_CHUNK_EVENTS = 16;

const MAX_SYNC_CHUNK_BYTES = 96 * 1024;

const SYNC_FLOW_WINDOW = 2;

const SYNC_FLOW_ACK_TIMEOUT_MS = 5_000;

const SYNC_FLOW_MAX_RETRIES = 3;

const normalizeCapVersion = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;

const normalizePeerCaps = (caps?: PeerCaps): NormalizedPeerCaps => {
  const normalized: NormalizedPeerCaps = {
    proto: normalizeCapVersion(caps?.proto, LEGACY_PEER_CAPS.proto),
    sync: { v: normalizeCapVersion(caps?.sync?.v, LEGACY_PEER_CAPS.sync.v),
      ...(caps?.sync?.inventory === 1 ? { inventory: 1 } : {}) },
    ratchet: { v: normalizeCapVersion(caps?.ratchet?.v, LEGACY_PEER_CAPS.ratchet.v) },
    media: {
      chunks: Boolean(caps?.media?.chunks),
      storedReceipts: caps?.media?.storedReceipts === true,
      v: normalizeCapVersion(caps?.media?.v, LEGACY_PEER_CAPS.media.v),
    },
    devices: {
      roles: Boolean(caps?.devices?.roles),
      v: normalizeCapVersion(caps?.devices?.v, LEGACY_PEER_CAPS.devices.v),
    },
  };

  if (caps?.binary?.envelope === 1 && caps.binary.packet === 2 && caps.binary.text === 1 &&
      caps.binary.media === 1 && caps.binary.retry === 1) normalized.binary = { envelope: 1, packet: 2, text: 1, media: 1, retry: 1 };

  return normalized;
};

export const __testNormalizePeerCaps = normalizePeerCaps;

const getPeerCaps = (convId: string, context?: ReceiveContext): NormalizedPeerCaps =>
  peerContexts.get(ownerKey(convId, context))?.peerCaps ?? LEGACY_PEER_CAPS;

export const canAutomaticallySendDeliveredReceipt = async (convId: string, context?: ReceiveContext) => {
  if (!context) return false;
  context.vault.assertLocal();

  if (!await isDeviceSyncAllowed(convId, "receipt-capability", context)) return false;
  context.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (peer?.deviceAuthorizationVersion !== 2 && !getCertifiedSessionState(convId, context).ready) return false;

  return Boolean(peer?.identityPub && peer.authenticatedCapsToken === context.owner.session.token && peer.peerCaps &&
    getPeerRatchetVersion(peer.peerCaps) === 2);
};

export const canUseBinaryMediaTransport = (convId: string, context?: ReceiveContext) =>
  getPeerCaps(convId, context).media.chunks && getPeerCaps(convId, context).media.v >= 2;

export const canAutomaticallySendMediaStorageReceipt = async (convId: string, context?: ReceiveContext) =>
  getPeerCaps(convId, context).media.storedReceipts === true && await canAutomaticallySendDeliveredReceipt(convId, context);

const hasKnownPeerCaps = (convId: string, context?: ReceiveContext) => Boolean(peerContexts.get(ownerKey(convId, context))?.peerCaps);

const getPeerCapsForEvent = (convKeyId: string, eventConvId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const eventCaps = peerContexts.get(ownerKey(eventConvId, context))?.peerCaps;

  if (eventCaps) return eventCaps;
  const contextCaps = peerContexts.get(ownerKey(convKeyId, context))?.peerCaps;

  if (contextCaps) return contextCaps;

  return LEGACY_PEER_CAPS;
};

const getPeerRatchetVersion = (caps: NormalizedPeerCaps) => {
  if (caps.ratchet.v >= 2) return 2;

  if (caps.ratchet.v >= 1) return 1;

  return 0;
};

const canUseRoleEvents = (caps: NormalizedPeerCaps) => caps.devices.roles && caps.devices.v >= 1;

const resolveSendEnvelopeKey = async (
  convId: string,
  logId: string,
  _ratchetBaseKey: Uint8Array,
  _legacyKey: Uint8Array, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!context) throw new Error("OWNER_REQUIRED");
  const peer = peerContexts.get(ownerKey(convId, context));
  const session = freshSessions.get(ownerKey(convId, context))?.outbound;

  if (!session || !peer || freshOffers.has(ownerKey(convId, context)) || freshCandidates.has(ownerKey(convId, context)))
    throw new Error("FRESH_SESSION_REQUIRED");

  if (peer.deviceAuthorizationVersion !== 2) await authenticatedFriendIdentity(convId, context);

  const ratchet = await protectRatchetOperation(convId, context, () => nextSendDhKey(freshRatchetChannel(logId, session.id), session.key,
    getSecretStore(context.owner.session)));

  return { msgKey: ratchet.msgKey, headerRk: ratchet.headerRk, friendSessionId: session.id };
};

const logPeerCaps = (convId: string, caps: NormalizedPeerCaps) => {
  console.debug("[sync] peer caps", {
    convId,
    proto: caps.proto,
    ratchet: caps.ratchet.v,
    mediaChunks: caps.media.chunks,
    roles: caps.devices.roles,
  });
};

const logDecrypt = (label: string, meta: { convId: string; eventId: string; mode: string }) => {
  console.debug(`[sync] ${label}`, meta);
};

const emitIncomingEnvelopeTrace = (
  event: string,
  context: Record<string, unknown> = {}
) => {
  emitFlowTraceLog({
    event: `incomingEnvelope:${event}`,
    source: "sync:incomingEnvelope",
    ...context,
  });
};

const isDeviceSyncAllowed = async (convId: string, reason: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer || (peer.kind !== "device" && peer.deviceAuthorizationVersion !== 2)) return true;
  const peerDeviceId = peer.peerDeviceId ?? peer.friendKeyId;

  if (!peerDeviceId) {
    console.warn("[sync] device sync blocked: missing peer device id", {
      convId,
      reason,
    });

    return false;
  }

  const localDeviceId = getOrCreateDeviceId(context);

  if (context && await getAccountRootIdentity(context)) {
    const approved = await getAuthorizedDevice(peerDeviceId, context, peer.accountRootIdentity);

    return Boolean(approved && approved.identityPub === peer.identityPub && approved.dhPub === peer.dhPub);
  }

  const [localApproval, peerApproval] = await Promise.all([
    getDeviceApproval(localDeviceId, context),
    getDeviceApproval(peerDeviceId, context),
  ]);

  const ownIdentity = context ? encodeBase64Url(await getIdentityPublicKey(context)) : undefined;

  const hasPeerApproval = Boolean(peerApproval && (!context || peerApproval.identityPub === peer.identityPub &&
    peerApproval.dhPub === peer.dhPub && peerApproval.approverIdentityPub === ownIdentity));

  const isBoundToPeer = localApproval?.approvedBy === peerDeviceId && (!context ||
    localApproval.identityPub === ownIdentity && localApproval.approverIdentityPub === peer.identityPub);

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

const isApprovedLinkedDevicePeer = async (convId: string, reason: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer || peer.kind !== "device" || (peer.accountRootIdentity && context &&
    peer.accountRootIdentity !== await getAccountRootIdentity(context))) {
    console.warn("[sync] linked-device event dropped from non-device peer", {
      convId,
      reason,
      peerKind: peer?.kind ?? "unknown",
    });

    return false;
  }

  return isDeviceSyncAllowed(convId, reason, context);
};

const perAuthorLamportSeen = new Map<string, number>();

const perConvLamportSeen = new Map<string, Map<string, number>>();

const peerContexts = new Map<string, PeerContext>();

const pendingHelloNonces = new Map<string, { nonce: string; createdAt: number }>();

const freshOffers = new Map<string, Awaited<ReturnType<typeof createSessionContribution>>>();

const freshSessions = new Map<string, { outbound?: FreshSession; inbound?: FreshSession; historyCatchupScheduled?: boolean }>();

const freshCandidates = new Map<string, FreshSession>();

const quarantinedRatchets = new Set<string>();

const assertRatchetNotQuarantined = async (channel: string, context: ReceiveContext) => {
  const key = ownerKey(channel, context);

  if (quarantinedRatchets.has(key)) throw new Error("ROLLBACK_SUSPECTED");
  const row = await context.vault.db.meta.get(`fresh_session_v1:${channel}`);

  if (row && JSON.parse(row.value).rollbackSuspected) {
    quarantinedRatchets.add(key);
    throw new Error("ROLLBACK_SUSPECTED");
  }
};

const retainRatchetQuarantine = async (channel: string, context: ReceiveContext, error: unknown) => {
  if (!(error instanceof Error) || error.message !== "ROLLBACK_SUSPECTED") return;
  quarantinedRatchets.add(ownerKey(channel, context));
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    const key = `fresh_session_v1:${channel}`, row = await context.vault.db.meta.get(key);
    const state = row ? JSON.parse(row.value) : undefined;

    if (state?.rollbackSuspected) return;
    await context.vault.db.meta.put({ key, value: JSON.stringify({ ...state, rollbackSuspected: true }) });
  });
};

const protectRatchetOperation = async <T>(channel: string, context: ReceiveContext, work: () => Promise<T>): Promise<T> => {
  await assertRatchetNotQuarantined(channel, context);

  try { return await work(); }
  catch (error) { await retainRatchetQuarantine(channel, context, error); throw error; }
};

const freshPeerControlTimes = new Map<string, number>();

const freshSessionWaiters = new Map<string, Promise<FreshSession>>();

const freshSendStages = new Map<string, string>();

const freshReceiveStages = new Map<string, string>();

type FreshRecoveryProgress = { attempted: number; sent: number; cleaned: number; completed: boolean; errors: Record<string, number>; error?: string };

const freshRecoveryStatus = new Map<string, FreshRecoveryProgress>();

const handshakeSecurityState = async (channel: string, context: ReceiveContext) => {
  const own = await getAccountRootIdentity(context), remote = peerContexts.get(ownerKey(channel, context))?.accountRootIdentity;
  const roots = [...new Set([own, remote].filter((root): root is string => Boolean(root)))];

  return (await Promise.all(roots.map(root => readSignedDeviceRegistry(context, root)))).flatMap(registry => Object.values(registry));
};

export const getCertifiedSessionState = (channel: string, context: ReceiveContext) => {
  context.vault.assertLocal();
  const session = freshSessions.get(ownerKey(channel, context));

  return { ready: Boolean(session?.outbound) && !quarantinedRatchets.has(ownerKey(channel, context)) && !freshOffers.has(ownerKey(channel, context)) && !freshCandidates.has(ownerKey(channel, context)),
    outboundId: session?.outbound?.id ?? null, inboundId: session?.inbound?.id ?? null,
    offer: freshOffers.has(ownerKey(channel, context)), candidate: freshCandidates.has(ownerKey(channel, context)),
    recovery: freshRecoveryStatus.get(ownerKey(channel, context)), sendStage: freshSendStages.get(ownerKey(channel, context)),
    receiveStage: freshReceiveStages.get(ownerKey(channel, context)),
    receiveBusy: receiveChains.has(`${context.owner.accountId.length}:${context.owner.accountId}${channel}`) };
};

type FreshIntent = { convId: string; partnerId: string; identityPub: string; dhPub: string; body: unknown;
  deviceTarget?: Pick<DeviceAuthorization, "deviceId" | "accountRootIdentityPub" | "identityPub" | "dhPub">;
  eventId: string; priority: "high" | "normal"; expiresAt: number; transferId?: string; chunkIndex?: number;
  sourceStamp?: string; preparedEventId?: string; binaryTransport?: boolean; outboxRetention?: "standard" | "transient";
  preparedSend?: { event: EventRecord; sessionId: string; ratchetChannel: string; marker: string; admitted?: boolean } };

const freshIntentPrefix = (channel: string) => `fresh_intent_v1:${channel}:`;

// Vault-encrypted application intent survives an offline handshake; it contains no session key.
const retainFreshIntent = async (conv: Conversation, partner: UserProfile, body: unknown, priority: "high" | "normal",
  options: DirectEnvelopeOptions, context: ReceiveContext) => {
  const target = options.deviceTarget;
  const channel = target ? deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId) : conv.id;
  const type = (body as { type?: string })?.type;
  const coalesced = type === "account_read" || type === "account_profile";
  const key = `${freshIntentPrefix(channel)}${coalesced ? `${type}:${conv.id}` : options.eventId}`;
  const previous = await context.vault.db.meta.get(key);

  let value: FreshIntent = { convId: conv.id, partnerId: partner.id, identityPub: partner.identityPub!, dhPub: partner.dhPub!,
    body, eventId: options.eventId!, priority, expiresAt: computeExpiresAt(Date.now()),
    binaryTransport: options.binaryTransport, outboxRetention: options.outboxRetention,
    ...(options.sourceStamp !== undefined ? { sourceStamp: options.sourceStamp } : {}),
    ...(target ? { deviceTarget: { deviceId: target.deviceId, accountRootIdentityPub: target.accountRootIdentityPub,
        identityPub: target.identityPub, dhPub: target.dhPub } } : {}),
    ...(options.transferId ? { transferId: options.transferId, chunkIndex: options.chunkIndex } : {}) };

  if (previous) {
    const old = await decryptJsonRecord<FreshIntent>(context.vault.key, key, "fresh-intent", previous.value);

    if (old.convId !== value.convId || old.partnerId !== value.partnerId || old.identityPub !== value.identityPub || old.dhPub !== value.dhPub ||
      encodeBase64Url(canonicalBytes(old.body)) !== encodeBase64Url(canonicalBytes(body)) ||
      JSON.stringify(old.deviceTarget) !== JSON.stringify(value.deviceTarget) || old.sourceStamp !== value.sourceStamp) {
      if (!coalesced) throw new Error("FRESH_INTENT_CONFLICT");
    } else {
      // An enqueue can survive without retirement; recover its binding before any session wait or hint write.
      const admitted = (old.preparedEventId ? await getOutbox(old.preparedEventId, context.vault) : undefined) ??
        (options.transferId ? await context.vault.db.outbox.where("convId").equals(channel).filter(row => {
          if (row.ownerAccountId !== context.owner.accountId || row.recipientIdentityPub !== (target?.identityPub ?? partner.identityPub) ||
              row.transferId !== options.transferId || row.chunkIndex !== options.chunkIndex) return false;

          // SAFETY: selected transfer rows are local sender Envelope JSON; this read only matches their logical delivery ID.
          const header = (JSON.parse(legacyOutboxCiphertext(row)) as Envelope).header;

          return (header.friendDeliveryId ?? header.deviceDelivery?.deliveryId) === options.eventId;
        }).first() : undefined);

      const binaryTransport = admitted ? admitted.binaryTransport : options.binaryTransport ?? old.binaryTransport;
      const outboxRetention = admitted ? admitted.retention : options.outboxRetention ?? old.outboxRetention;
      const preparedEventId = admitted?.id ?? old.preparedEventId;

      if (binaryTransport === old.binaryTransport && outboxRetention === old.outboxRetention && preparedEventId === old.preparedEventId) {
        return { ...previous, binaryTransport: old.binaryTransport, outboxRetention: old.outboxRetention, preparedEventId: old.preparedEventId };
      }

      // Persist changed pre-enqueue hints before a crash can separate the row from its intent.
      value = { ...old, binaryTransport, outboxRetention, preparedEventId };
    }
  }

  const keyId = await computeVaultKeyId(context.vault.key);
  const encrypted = await encryptJsonRecord(context.vault.key, key, "fresh-intent", value);
  const record = { key, value: encrypted };
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    const storedKeyId = (await context.vault.db.meta.get("vault_key_id_v1"))?.value;

    if (storedKeyId && storedKeyId !== keyId) throw new Error("OWNER_SESSION_CHANGED");

    if ((await context.vault.db.meta.get(key))?.value !== previous?.value) throw new Error("FRESH_INTENT_CONFLICT");
    await context.vault.db.meta.put(record);
  });

  return { ...record, binaryTransport: value.binaryTransport, outboxRetention: value.outboxRetention, preparedEventId: value.preparedEventId };
};

const retireFreshIntent = async (intent: { key: string; value: string }, prepared: { header: EnvelopeHeader; envelopeJson: string }, context: ReceiveContext) => {
  const value = await decryptJsonRecord<FreshIntent>(context.vault.key, intent.key, "fresh-intent", intent.value);

  const media = (value.body as { type?: string; phase?: string })?.type === "account_media" ||
    (value.body as { type?: string; phase?: string })?.type === "media" && (value.body as { phase?: string }).phase === "chunk";

  const admitted = media ? await getOutbox(prepared.header.eventId, context.vault) : undefined;
  const pending = media ? await encryptJsonRecord(context.vault.key, intent.key, "fresh-intent", { ...value,
    preparedEventId: prepared.header.eventId, binaryTransport: admitted?.binaryTransport, outboxRetention: admitted?.retention }) : undefined;
  await writeVault(context.vault, [context.vault.db.meta, context.vault.db.outbox], async () => {
    const row = await context.vault.db.outbox.get(prepared.header.eventId);

    if (row?.ownerAccountId === context.owner.accountId && row.ciphertext === prepared.envelopeJson &&
      (await context.vault.db.meta.get(intent.key))?.value === intent.value) {
      if (value.preparedSend?.admitted && row.status !== "acked" && row.status !== "expired") return;

      if (pending && row.status !== "acked") {
        if (row.binaryTransport !== admitted?.binaryTransport || row.retention !== admitted?.retention) throw new Error("OWNER_OUTBOX_MISMATCH");
        await context.vault.db.meta.put({ key: intent.key, value: pending });
      }
      else await context.vault.db.meta.delete(intent.key);
    }
  });
};

/** Durable admission replaces the send proof; cleanup never changes delivery or Native state. */
const retireAdmittedSendIntent = async (channel: string, record: { key: string; value: string }, intent: FreshIntent, context: ReceiveContext) => {
  const staged = intent.preparedSend;

  if (!staged?.admitted) return false;

  return withReceiveChain(context.owner.accountId, channel, async () => {
    await context.vault.assertMain();
    const active = freshSessions.get(ownerKey(channel, context))?.outbound;

    if (!active) throw new Error("FRESH_SESSION_REQUIRED");
    await assertCurrentFriendSession(channel, active.id, context);
    const profile = await context.vault.db.profiles.get(intent.partnerId);
    const conversation = await context.vault.db.conversations.get(channel);

    if (!profile || !conversation || intent.deviceTarget || intent.convId !== channel ||
        record.key !== `${freshIntentPrefix(channel)}${intent.eventId}`) throw new Error("SEND_COMMIT_UNCONFIRMED");
    const partner = await decryptJsonRecord<UserProfile>(context.vault.key, profile.id, "profile", profile.enc_b64);
    const conv = await decryptJsonRecord<Conversation>(context.vault.key, conversation.id, "conv", conversation.enc_b64);

    if (partner.kind !== "friend" || partner.identityPub !== peerContexts.get(ownerKey(channel, context))?.identityPub ||
        partner.identityPub !== intent.identityPub || partner.dhPub !== intent.dhPub || conv.type !== "direct" ||
        conv.hidden || conv.blocked || !conv.participants.includes(partner.id)) throw new Error("OWNER_PEER_MISMATCH");
    const event = staged.event;
    const wire = legacyEventJson(event);
    const envelope: unknown = JSON.parse(wire);

    if (!isEnvelopeLike(envelope) || envelope.header.rk?.v !== 2 || envelope.header.deviceDelivery || envelope.header.friendDeliveryId !== intent.eventId ||
        envelope.header.friendSessionId !== staged.sessionId || envelope.header.eventId !== event.eventId ||
        envelope.header.convId !== channel || event.convId !== channel || event.localConvId !== channel ||
        envelope.header.authorDeviceId !== getOrCreateDeviceId(context) || event.authorDeviceId !== envelope.header.authorDeviceId ||
        event.lamport !== envelope.header.lamport || event.ts !== envelope.header.ts || event.prevHash !== envelope.header.prev ||
        staged.marker !== event.eventHash || await computeEnvelopeHash(envelope) !== staged.marker ||
        staged.ratchetChannel !== freshRatchetChannel(channel, staged.sessionId) ||
        !await verifyEnvelopeSignature(envelope, await getIdentityPublicKey(context))) throw new Error("SEND_COMMIT_UNCONFIRMED");
    const keyId = await computeVaultKeyId(context.vault.key);

    const validate = (retire: boolean) => writeVault(context.vault, [context.vault.db.meta, context.vault.db.events,
      context.vault.db.outbox, context.vault.db.profiles, context.vault.db.conversations], async () => {
      if (freshSessions.get(ownerKey(channel, context))?.outbound?.id !== active.id || freshOffers.has(ownerKey(channel, context)) ||
          freshCandidates.has(ownerKey(channel, context))) throw new Error("FRESH_SESSION_REQUIRED");

      if ((await context.vault.db.meta.get(record.key))?.value !== record.value) throw new Error("FRESH_INTENT_CONFLICT");
      const storedKey = (await context.vault.db.meta.get("vault_key_id_v1"))?.value;

      if (storedKey && storedKey !== keyId) throw new Error("OWNER_SESSION_CHANGED");

      if (!sameStoredCiphertext((await context.vault.db.profiles.get(profile.id))?.enc_b64, profile.enc_b64) ||
          !sameStoredCiphertext((await context.vault.db.conversations.get(channel))?.enc_b64, conversation.enc_b64)) throw new Error("OWNER_PEER_MISMATCH");
      const row = await context.vault.db.outbox.get(event.eventId);
      const stored = await context.vault.db.events.get(event.eventId);

      if (!row || row.payloadFormat !== undefined || row.ownerAccountId !== context.owner.accountId || row.convId !== channel ||
          row.recipientIdentityPub !== partner.identityPub || row.ciphertext !== wire || row.transferId !== intent.transferId ||
          row.chunkIndex !== intent.chunkIndex || Boolean(row.binaryTransport) !== Boolean(intent.binaryTransport) ||
          (row.retention ?? "standard") !== (intent.outboxRetention ?? "standard") || !stored || stored.envelopeFormat !== undefined ||
          stored.envelopeJson !== wire || stored.eventHash !== staged.marker || stored.convId !== channel || stored.localConvId !== channel ||
          stored.authorDeviceId !== event.authorDeviceId || stored.lamport !== event.lamport || stored.ts !== event.ts ||
          stored.prevHash !== event.prevHash) throw new Error("SEND_COMMIT_UNCONFIRMED");
      // Keep every nonterminal intent as a fence, including across a future SID change.

      if (retire && (row.status === "acked" || row.status === "expired")) {
        await context.vault.db.meta.delete(record.key);

        return true;
      }

      return false;
    });

    await validate(false);
    await assertCurrentFriendSession(channel, active.id, context);

    try {
      await protectRatchetOperation(channel, context, () => acknowledgeSendCommit(staged.ratchetChannel, staged.marker, getSecretStore(context.owner.session)));
    } catch (error) {
      if (error instanceof Error && error.message === "RATCHET_PRIOR_PROCESS") throw new Error("SEND_COMMIT_PRIOR_PROCESS");

      if (error instanceof Error && error.message === "SECRET_STORE_WRITE_FAILED") throw new Error("SEND_COMMIT_CLEANUP_UNCONFIRMED");
      throw error;
    }

    await assertCurrentFriendSession(channel, active.id, context);

    const retired = await validate(true);

    return retired ? "retired" : "retained";
  }, context);
};

const persistFreshSession = async (channel: string, session: FreshSession, context: ReceiveContext,
  retainNonce: () => Promise<void>) => {
  await assertRatchetNotQuarantined(channel, context);
  await assertCurrentSessionIdentity(session.initiator, context, channel);
  await assertCurrentSessionIdentity(session.responder, context, channel);
  await retainNonce();
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    await assertRatchetNotQuarantined(channel, context);
    await context.vault.db.meta.put({ key: `fresh_session_v1:${channel}`,
      value: JSON.stringify({ id: session.id, createdAt: session.createdAt }) });
  });
};

const sessionDeliveryId = async (id: string, session: FreshSession) => `session-delivery:${encodeBase64Url(
  (await getSodium()).crypto_hash_sha256(canonicalBytes({ protocol: "nkc:session-delivery:v1", id, sessionId: session.id })))}`;

const localFriendIdentity = async (context: ReceiveContext): Promise<FriendSessionIdentity> => ({
  kind: "FRIEND_BOUND", identityPub: encodeBase64Url(await getIdentityPublicKey(context)),
  dhPub: encodeBase64Url(await getDhPublicKey(context)), deviceId: getOrCreateDeviceId(context),
});

const authenticatedFriendIdentity = async (channel: string, context: ReceiveContext, hint?: Pick<UserProfile, "identityPub" | "dhPub">): Promise<FriendSessionIdentity> => {
  const conv = (await listConversations(context.vault)).find(row => row.id === channel && row.type !== "group");
  const pin = hint ?? peerContexts.get(ownerKey(channel, context));

  const peers = (await listProfiles(context.vault)).filter(row => row.kind === "friend" && conv?.participants.includes(row.id) &&
    (!pin || row.identityPub === pin.identityPub && row.dhPub === pin.dhPub));

  const peer = peers.length === 1 ? peers[0] : undefined;

  if (!peer) throw new Error("OWNER_PEER_MISMATCH");

  if (conv?.blocked || !hasAuthenticatedFriendKeys(peer) || peer.friendStatus !== "normal" || peer.trust?.status === "blocked" ||
    peer.verification?.status === "key_changed") throw new Error("FRIEND_AUTHENTICATION_REQUIRED");
  const deviceId = peer.primaryDeviceId ?? peer.routingHints?.deviceId ?? peer.deviceId;

  if (!deviceId) throw new Error("LEGACY_REAUTH_REQUIRED");
  await context.vault.assertMain();

  return { kind: "FRIEND_BOUND", identityPub: peer.identityPub!, dhPub: peer.dhPub!, deviceId };
};

/** RAM readiness is never reconstructed from a restored marker or ratchet snapshot. */
export const assertCurrentFriendSession = async (channel: string, sessionId: string | undefined, context: ReceiveContext) => {
  await assertRatchetNotQuarantined(channel, context);
  const local = await localFriendIdentity(context), remote = await authenticatedFriendIdentity(channel, context);
  const key = ownerKey(channel, context), session = freshSessions.get(key)?.outbound;

  if (!sessionId || session?.id !== sessionId || !matchesFreshSession(session, local, remote) ||
    freshOffers.has(key) || freshCandidates.has(key)) throw new Error("FRESH_SESSION_REQUIRED");

  return session;
};

export const assertCurrentDeviceSession = async (channel: string, sessionId: string | undefined,
  target: DeviceAuthorization, context: ReceiveContext) => {
  await assertRatchetNotQuarantined(channel, context);
  const key = ownerKey(channel, context), session = freshSessions.get(key)?.outbound;
  const own = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

  if (!sessionId || session?.id !== sessionId || !own || !matchesFreshSession(session, own, target) ||
    freshOffers.has(key) || freshCandidates.has(key)) throw new Error("FRESH_SESSION_REQUIRED");
  await assertCurrentSessionIdentity(session.initiator, context, channel);
  await assertCurrentSessionIdentity(session.responder, context, channel);
  await context.vault.assertMain();

  if (freshSessions.get(key)?.outbound !== session || freshOffers.has(key) || freshCandidates.has(key)) {
    throw new Error("FRESH_SESSION_REQUIRED");
  }

  return session;
};

const assertFreshContribution = async (contribution: SessionContribution, context: ReceiveContext, channel: string) => {
  validateSessionContribution(contribution);
  await assertCurrentSessionIdentity(contribution.authorization, context, channel);
};

const assertCurrentSessionIdentity = async (cert: SessionIdentity, context: ReceiveContext, channel: string) => {
  if (cert.kind === "FRIEND_BOUND") {
    if (peerContexts.get(ownerKey(channel, context))?.deviceAuthorizationVersion === 2) throw new Error("FRESH_SESSION_AUTHORIZATION_CHANGED");
    const local = await localFriendIdentity(context), remote = await authenticatedFriendIdentity(channel, context);

    if (!sameSessionIdentity(cert, local) && !sameSessionIdentity(cert, remote)) throw new Error("FRESH_SESSION_AUTHORIZATION_CHANGED");

    return;
  }

  if (peerContexts.get(ownerKey(channel, context))?.deviceAuthorizationVersion !== 2) throw new Error("FRESH_SESSION_AUTHORIZATION_CHANGED");
  const current = await getAuthorizedDevice(cert.deviceId, context, cert.accountRootIdentityPub);

  if (!current || !sameCertificate(current, cert)) throw new Error("FRESH_SESSION_AUTHORIZATION_CHANGED");
};

const ensureFreshOutboundSession = async (channel: string, target: SessionIdentity, context: ReceiveContext): Promise<FreshSession> => {
  await context.vault.assertMain();
  await assertRatchetNotQuarantined(channel, context);
  const key = ownerKey(channel, context);
  let session = freshSessions.get(key)?.outbound;
  const own = target.kind === "FRIEND_BOUND" ? await localFriendIdentity(context) : await getAuthorizedDevice(getOrCreateDeviceId(context), context);

  const hint: PeerContext = target.kind === "FRIEND_BOUND" ? { kind: "friend", identityPub: target.identityPub, dhPub: target.dhPub,
    peerDeviceId: target.deviceId, friendKeyId: target.deviceId } : {
    kind: target.accountRootIdentityPub === await getAccountRootIdentity(context) ? "device" : "friend", deviceAuthorizationVersion: 2,
    accountRootIdentity: target.accountRootIdentityPub, identityPub: target.identityPub, dhPub: target.dhPub,
    peerDeviceId: target.deviceId, friendKeyId: target.deviceId, onionAddr: target.route?.onionAddr, inboxWriteToken: target.route?.inboxWriteToken };

  if (session && (!own || !matchesFreshSession(session, own, target))) {
    session.key.fill(0); freshSessions.delete(key); session = undefined;
  }

  const pendingHello = pendingHelloNonces.get(sessionKey(channel, context)), candidate = freshCandidates.get(key);

  if (candidate && Date.now() - candidate.createdAt > 15_000 || freshOffers.has(key) && pendingHello && Date.now() - pendingHello.createdAt > 15_000) {
    // A pending authenticated handshake owns its state until the session lock is released.
    if (friendControlLocks.has(`session:${sessionKey(channel, context)}`)) throw new Error("FRESH_SESSION_REQUIRED");
    freshOffers.get(key)?.privateKey.fill(0); freshOffers.delete(key);

    if (candidate) countSessionStage("candidate-expire", "rejected");
    candidate?.key.fill(0); freshCandidates.delete(key);
    session?.key.fill(0); freshSessions.delete(key); session = undefined;
  }

  if (session && !freshOffers.has(key) && !freshCandidates.has(key)) return session;
  const pending = freshSessionWaiters.get(key);

  if (pending && !context.owner.mailboxDeviceId) return pending;

  if (context.owner.mailboxDeviceId) {
    if (!freshOffers.has(key) && !freshCandidates.has(key)) await connectConversation(channel, hint, context);
    throw new Error("FRESH_SESSION_REQUIRED");
  }

  const wait = (async () => {
    if (!freshOffers.has(key) && !freshCandidates.has(key)) await connectConversation(channel, hint, context);
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      await context.vault.assertMain();
      const current = freshSessions.get(key)?.outbound;

      if (current && !freshOffers.has(key) && !freshCandidates.has(key)) return current;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    throw new Error("FRESH_SESSION_REQUIRED");
  })();

  freshSessionWaiters.set(key, wait);

  try { return await wait; }
  finally { if (freshSessionWaiters.get(key) === wait) freshSessionWaiters.delete(key); }
};

/** Rewrap existing durable outgoing intents after key replacement; never acknowledge an undelivered old ciphertext. */
const resumeFreshSessionOutbox = (channel: string, captured: ReceiveContext) => {
  const progress: FreshRecoveryProgress = { attempted: 0, sent: 0, cleaned: 0, completed: false, errors: {} };
  freshRecoveryStatus.set(ownerKey(channel, captured), progress);
  setTimeout(() => { void (async () => {
      const context = Object.freeze({ ...captured, owner: Object.freeze({ ...captured.owner, mailboxDeviceId: "" }) });
      await context.vault.assertMain();
      const peer = peerContexts.get(ownerKey(channel, context));

      if (!peer?.peerDeviceId) return;

      const target = peer.deviceAuthorizationVersion === 2 && peer.accountRootIdentity
        ? await getAuthorizedDevice(peer.peerDeviceId, context, peer.accountRootIdentity) : undefined;

      const active = freshSessions.get(ownerKey(channel, context))?.outbound;

      if (!active || peer.deviceAuthorizationVersion === 2 && !target) return;

      if (!target) await assertCurrentFriendSession(channel, active.id, context);

      const rejectItem = async (error: unknown) => {
        const code = error instanceof Error && ["OWNER_PEER_MISMATCH", "DEVICE_AUTHORIZATION_REQUIRED", "INVALID_APPLICATION_BODY",
          "LOGICAL_MESSAGE_BINDING_REJECTED", "GROUP_MEMBER_UNMAPPED", "OUTGOING_SOURCE_CHANGED", "MEDIA_CHUNK_CONFLICT", "MEDIA_MANIFEST_UNAVAILABLE",
          "SEND_COMMIT_UNCONFIRMED", "SEND_COMMIT_OLD_SESSION", "SEND_COMMIT_TERMINAL", "SEND_COMMIT_CAPACITY", "SEND_COMMIT_CLEANUP_CONFLICT",
          "FRESH_INTENT_CONFLICT", "SEND_COMMIT_PRIOR_PROCESS", "SEND_COMMIT_CLEANUP_UNCONFIRMED"].find(value => value === error.message);

        if (!code) throw error;
        await context.vault.assertMain();

        if (target) await assertCurrentDeviceSession(channel, active.id, target, context);
        else await assertCurrentFriendSession(channel, active.id, context);
        progress.error = code;
        progress.errors[code] = (progress.errors[code] ?? 0) + 1;
      };

      const retainedAdmissions = new Set<string>();

      for (const record of await context.vault.db.meta.where("key").startsWith(freshIntentPrefix(channel)).toArray()) {
        try {
          const intent = await decryptJsonRecord<FreshIntent>(context.vault.key, record.key, "fresh-intent", record.value);

          // Cleanup refusal must not reopen legacy rewrap for an admitted packet.
          if (intent.preparedSend?.admitted) retainedAdmissions.add(intent.preparedSend.event.eventId);

          const cleanup = await retireAdmittedSendIntent(channel, record, intent, context);

          if (cleanup) {
            if (cleanup === "retired") progress.cleaned++;
            else if (intent.preparedSend) {
              if (intent.preparedSend.sessionId !== active.id) throw new Error("SEND_COMMIT_OLD_SESSION");
            }

            continue;
          }

          if (intent.expiresAt <= Date.now() || intent.preparedEventId && (await context.vault.db.outbox.get(intent.preparedEventId))?.status === "acked") {
            // An expiry is not proof that a prepared Ratchet commit failed.
            if (intent.preparedSend) throw new Error("SEND_COMMIT_TERMINAL");
            await writeVault(context.vault, [context.vault.db.meta], async () => {
              if ((await context.vault.db.meta.get(record.key))?.value === record.value) await context.vault.db.meta.delete(record.key);
            });
            continue;
          }

          // SAFETY: Only optional dispatch fields are read; sendOwnedDirectEnvelope revalidates the signed body.
          const metadata = intent.body as { type?: string; v?: number };
          const authorization = target && metadata?.type === "account_device" && metadata.v === 2;

          const conv = (await listConversations(context.vault)).find(item => item.id === intent.convId) ??
            (authorization && intent.convId === channel ? { id: channel, participants: [], name: "", pinned: false,
              unread: 0, hidden: false, muted: false, blocked: false, lastTs: 0, lastMessage: "" } : undefined);

          const partner = (await listProfiles(context.vault)).find(item => item.id === intent.partnerId) ??
            (authorization && intent.partnerId === target.deviceId ? { id: target.deviceId, kind: "friend" as const,
              displayName: "", status: "", theme: "dark" as const, identityPub: target.accountRootIdentityPub, dhPub: target.dhPub } : undefined);

          if (!conv || !partner || partner.identityPub !== intent.identityPub || partner.dhPub !== intent.dhPub) throw new Error("OWNER_PEER_MISMATCH");

          if (target ? !intent.deviceTarget || target.deviceId !== intent.deviceTarget.deviceId ||
            target.accountRootIdentityPub !== intent.deviceTarget.accountRootIdentityPub || target.identityPub !== intent.deviceTarget.identityPub ||
            target.dhPub !== intent.deviceTarget.dhPub : Boolean(intent.deviceTarget)) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
          progress.attempted++;
          await sendOwnedDirectEnvelope(conv, partner, intent.body, intent.priority, { context, eventId: intent.eventId, deviceTarget: target ?? undefined,
            reuseEvent: true, allowDeferred: true, transferId: intent.transferId, chunkIndex: intent.chunkIndex, sourceStamp: intent.sourceStamp });
          progress.sent++;
        } catch (error) { await rejectItem(error); }
      }

      const rows = await context.vault.db.outbox.where("convId").equals(channel).toArray();

      for (const row of rows) {
        try {
          await context.vault.assertMain();

          if (["acked", "expired"].includes(row.status) || retainedAdmissions.has(row.id)) continue;
          let envelope: Envelope;

          try { envelope = JSON.parse(legacyOutboxCiphertext(row)) as Envelope; } catch { continue; }

          if (!envelope.header || (envelope.header.deviceDelivery?.sessionId ?? envelope.header.friendSessionId) === active.id ||
            (target ? envelope.header.deviceDelivery?.recipientDeviceId !== target.deviceId : Boolean(envelope.header.deviceDelivery))) continue;
          const event = await getEvent(row.id, context.vault);

          if (!event) continue;

          const body = event.outgoingBody_enc ? await decryptJsonRecord(context.vault.key, event.eventId, `outgoing:${event.eventHash}`, event.outgoingBody_enc)
            : event.logicalMessageId ? (await getStoredMessage(event.logicalMessageId, context.vault))?.logicalProof : undefined;

          if (!body) continue;
          const profiles = await listProfiles(context.vault), conversations = await listConversations(context.vault);

          const conv = conversations.find(item => item.id === event.localConvId) ?? { id: channel, participants: [], name: "", pinned: false,
            unread: 0, hidden: false, muted: false, blocked: false, lastTs: 0, lastMessage: "" };

          const ownRoot = await getAccountRootIdentity(context);
          const metadata = body as { type?: string; v?: number };

          const partner = profiles.find(item => item.kind === "friend" && conv.participants.includes(item.id) &&
            (target ? target.accountRootIdentityPub === ownRoot || item.identityPub === target.accountRootIdentityPub : item.identityPub === peer.identityPub)) ??
            (target && metadata.v === 2 && (metadata.type === "account_device" || target.accountRootIdentityPub === ownRoot &&
              ["account_profile", "contact", "conv"].includes(metadata.type ?? ""))
              ? { id: target.deviceId, kind: "friend" as const, displayName: "", status: "", theme: "dark" as const,
                identityPub: target.accountRootIdentityPub, dhPub: target.dhPub } : undefined);

          if (!partner) continue;
          progress.attempted++;
          await sendOwnedDirectEnvelope(conv, partner, body, row.priority, { context, deviceTarget: target ?? undefined, v2Only: true,
            reuseEvent: true, allowDeferred: true, eventId: envelope.header.deviceDelivery?.deliveryId ?? envelope.header.friendDeliveryId ?? row.id,
            transferId: row.transferId, chunkIndex: row.chunkIndex, sourceStamp: event.outgoingSourceStamp,
            binaryTransport: row.binaryTransport, outboxRetention: row.retention });
          progress.sent++;
          await writeVault(context.vault, [context.vault.db.outbox], async () => {
            const current = await context.vault.db.outbox.get(row.id);

            if (!current || !sameOutboxPayload(current, row) || current.ownerAccountId !== context.owner.accountId ||
                current.status === "acked" || current.status === "expired") return;
            await context.vault.db.outbox.update(row.id, { status: "expired", lastError: "SESSION_SUPERSEDED", nativeRetryStopped: false });
          });
          await reconcileAcknowledgedNativeRetries(context.vault, [row.id]);
        } catch (error) { await rejectItem(error); }
      }

      await resumeStoredMediaTransfers(channel, peer, target, context, rejectItem);
      await resumeCertifiedStorageReceipts(channel, context);
    })().catch(error => {
      progress.error = ["FRESH_SESSION_REQUIRED", "OWNER_PEER_MISMATCH", "OWNER_SESSION_CHANGED", "DEVICE_AUTHORITY_CHANGED",
        "INVALID_APPLICATION_BODY", "LOGICAL_MESSAGE_BINDING_REJECTED", "GROUP_MEMBER_UNMAPPED", "DEVICE_AUTHORIZATION_REQUIRED", "OUTGOING_SOURCE_CHANGED", "FRESH_INTENT_CONFLICT"]
        .find(code => error instanceof Error && error.message === code) ?? "RECOVERY_FAILED";
    }).finally(() => { progress.completed = true; }); }, 0);
};

export const __testResumeFreshSessionOutbox = resumeFreshSessionOutbox;

/** Durable bytes and progress also cover a crash before the next chunk intent existed. */
const resumeStoredMediaTransfers = async (channel: string, peer: PeerContext, target: DeviceAuthorization | null | undefined, context: ReceiveContext,
  rejectItem: (error: unknown) => Promise<void>) => {
  const recipient = target?.accountRootIdentityPub ?? peer.identityPub;
  const profiles = await listProfiles(context.vault), user = profiles.find(row => row.kind === "user");

  if (!recipient || !user) return;

  for (const row of await context.vault.db.mediaTransfers.toArray()) {
    try {
      await context.vault.assertMain();
      const progress = await decryptJsonRecord<import("../storage/mediaTransferStore").MediaTransferProgress>(context.vault.key, row.transferId, "mediaTransfer", row.enc_b64);

      if (progress.status !== "active" || !progress.recipients?.includes(recipient)) continue;
      const message = await getStoredMessage(row.transferId, context.vault), media = message && parseIncomingMediaRef(message.media, message.id);
      const conv = (await listConversations(context.vault)).find(item => item.id === progress.convId);
      const partner = profiles.find(item => item.kind === "friend" && item.identityPub === recipient && conv?.participants.includes(item.id));

      if (!message || !media || !conv || !partner || !Number.isFinite(message.ts) || computeExpiresAt(message.ts) <= Date.now() ||
        message.senderId !== user.id || message.convId !== conv.id ||
        conv.hidden || conv.blocked || media.total !== progress.totalChunks ||
        await context.vault.db.tombstones.get(message.id) || await context.vault.db.tombstones.get(conv.id) ||
        (!target && channel !== conv.id)) continue;
      const logical = message.logicalProof;

      if (Boolean(target) !== Boolean(logical)) continue;

      if (progress.storedThrough !== media.total - 1) {
        // A crash may commit the final bytes before the progress marker; validate every retained chunk first.
        let verifiedChunks = 0;

        try {
          for await (const chunk of readMessageMediaChunks(media, context.vault)) {
            if (chunk.idx !== verifiedChunks++) throw new Error("MEDIA_CHUNK_CONFLICT");
          }
        } catch (error) {
          if (error instanceof Error && ["MEDIA_CHUNK_CONFLICT", "MEDIA_FILE_CHANGED", "MEDIA_CUSTODY_INVALID"].includes(error.message)) {
            throw new Error("OUTGOING_SOURCE_CHANGED");
          }

          throw error;
        }

        if (verifiedChunks !== media.total) throw new Error("OUTGOING_SOURCE_CHANGED");
        await markMediaTransferStored(message.id, media.total - 1, context.vault);
      }

      const manifestId = target ? await deviceDeliveryIdentity(logical!.id, target, getOrCreateDeviceId(context)) : message.id;
      await sendOwnedDirectEnvelope(conv, partner, logical ?? { type: "msg", text: message.text, media, clientBatchId: message.clientBatchId }, "normal",
        { context, deviceTarget: target ?? undefined, eventId: manifestId, reuseEvent: true, queueOnly: true });
      const acknowledged = progress.acknowledgements?.[recipient];

      for await (const chunk of readMessageMediaChunks(media, context.vault)) {
        if (chunk.idx <= (acknowledged?.ackedThrough ?? -1) || acknowledged?.ackedOutOfOrder.includes(chunk.idx)) continue;

        if (target) await sendAccountMediaChunk(conv, partner, message.id, chunk.idx, chunk.bytes, context, { target, queueOnly: true });
        else {
          const eventId = `${message.id}:chunk:${chunk.idx}`, key = `${freshIntentPrefix(channel)}${eventId}`;
          const retained = await context.vault.db.meta.get(key);
          const intent = retained ? await decryptJsonRecord<FreshIntent>(context.vault.key, key, "fresh-intent", retained.value) : undefined;
          // Retried chunks keep their admitted body (including UI batch fields), not a reconstructed variant.
          await sendOwnedDirectEnvelope(conv, partner, intent?.body ?? { type: "media", phase: "chunk", ...media, idx: chunk.idx, b64: encodeBase64Url(chunk.bytes) }, "normal",
            { context, eventId, reuseEvent: true, queueOnly: true, transferId: message.id, chunkIndex: chunk.idx, sourceStamp: intent?.sourceStamp });
        }

        if (chunk.idx % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) { await rejectItem(error); }
  }
};

const seenHelloNonces = new Map<string, number>();

const HANDSHAKE_NONCE_TTL_MS = 5 * 60 * 1000;

const MAX_SEEN_HELLO_NONCES = 2048;

const deferredRoleEvents = new Map<string, Map<string, RoleChangeEvent>>();

const convSubscriptions = new Map<string, () => void>();

type OutgoingFlowSession = {
  convId: string;
  context?: ReceiveContext;
  frames: SyncResFrame[];
  expiresAt: number;
  nextToSend: number;
  inFlight: Map<number, { attempts: number; timer: ReturnType<typeof setTimeout> }>;
};

const outgoingFlowSessions = new Map<string, OutgoingFlowSession>();

let localUserIdCache: string | null | undefined;

const deferRoleChangeEvent = (convId: string, eventId: string, event: RoleChangeEvent, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  let pending = deferredRoleEvents.get(ownerKey(convId, context));

  if (!pending) {
    pending = new Map();
    setReceiveCache(context, deferredRoleEvents, ownerKey(convId, context), pending);
  }

  pending.set(eventId, event);
};

const flushDeferredRoleEvents = async (convId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const pending = deferredRoleEvents.get(ownerKey(convId, context));

  if (!pending || pending.size === 0) return;

  if (!hasKnownPeerCaps(convId, context)) return;

  if (!canUseRoleEvents(getPeerCaps(convId, context))) {
    console.warn("[sync] deferred role changes dropped: peer capability missing", {
      convId,
      capsState: "known_unsupported",
      count: pending.size,
    });
    deleteReceiveCache(context, deferredRoleEvents, ownerKey(convId, context));

    return;
  }

  const entries = Array.from(pending.entries()).sort((lhs, rhs) => lhs[1].ts - rhs[1].ts);

  for (const [eventId, roleEvent] of entries) {
    try {
      await updateFromRoleEvent(roleEvent, context);
      pending.delete(eventId);
    } catch (error) {
      console.warn("[sync] deferred role change apply failed", { convId, eventId, error });
    }
  }

  if (pending.size === 0) deleteReceiveCache(context, deferredRoleEvents, ownerKey(convId, context));
};

const resolveLocalUserId = async (context?: ReceiveContext) => {
  context?.vault.assertLocal();

  if (!context && localUserIdCache !== undefined) return localUserIdCache;
  const profiles = await listProfiles(context?.vault);
  const user = profiles.find((profile) => profile.kind === "user") || null;

  if (context) return user?.id ?? null;
  localUserIdCache = user?.id ?? null;

  return localUserIdCache;
};

const resolveSenderProfile = async (
  peerConvId: string,
  conv: Conversation | null,
  currentUserId: string | null, context?: ReceiveContext
) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(peerConvId, context));

  if (!peer) return null;
  const profiles = await listProfiles(context?.vault);
  const friends = profiles.filter((profile) => profile.kind === "friend");

  const match =
    friends.find((friend) => peer.friendKeyId && friend.id === peer.friendKeyId) ||
    friends.find((friend) => peer.friendKeyId && friend.friendId === peer.friendKeyId) ||
    friends.find((friend) => peer.identityPub && friend.identityPub === peer.identityPub) ||
    null;

  if (match) return match;

  if (!conv || !currentUserId || !peer.identityPub || !peer.dhPub) return null;
  const partnerId = conv.participants.find((id) => id && id !== currentUserId);

  if (!partnerId) return null;
  let friendId: string;

  try {
    friendId = computeFriendId(decodeBase64Url(peer.identityPub));
  } catch {
    return null;
  }

  const now = Date.now();

  const recovered: UserProfile = {
    id: partnerId,
    friendId,
    displayName: conv.name || `Friend ${friendId.slice(0, 6)}`,
    status: "",
    theme: "dark",
    kind: "friend",
    friendStatus: "deleted",
    identityPub: peer.identityPub,
    dhPub: peer.dhPub,
    routingHints: sanitizeRoutingHints({
      onionAddr: peer.onionAddr,
      deviceId: peer.peerDeviceId,
    }),
    primaryDeviceId: peer.peerDeviceId,
    trust: { pinnedAt: now, status: "trusted" },
    verification: { status: "unverified" },
    reachability: peer.peerDeviceId
      ? { status: "ok", lastAttemptAt: now }
      : { status: "unreachable", lastError: "Missing deviceId" },
    createdAt: now,
    updatedAt: now,
  };

  await saveProfile(recovered, context?.vault);

  return recovered;
};

const repairDirectConversationPeerBinding = async (
  convId: string,
  friend: UserProfile,
  localUserId: string | null, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!localUserId || friend.kind !== "friend") return false;
  const conversation = (await listConversations(context?.vault)).find((item) => item.id === convId);

  if (
    !conversation ||
    conversation.type !== "direct" ||
    conversation.participants.length !== 2 ||
    !conversation.participants.includes(localUserId) ||
    conversation.participants.includes(friend.id)
  ) {
    return false;
  }

  await saveConversation({
    ...conversation,
    participants: conversation.participants.map((participantId) =>
      participantId === localUserId ? participantId : friend.id
    ),
  }, context?.vault);
  console.warn("[sync] repaired direct conversation peer binding", {
    convId,
    friendId: friend.friendId ?? friend.id,
  });

  return true;
};

const createNonce = () => {
  const bytes = new Uint8Array(16);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  }

  return encodeBase64Url(bytes);
};

const signHandshake = async (payload: Record<string, unknown>, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const sodium = await getSodium();
  const identityPriv = await getIdentityPrivateKey(context);
  const sig = sodium.crypto_sign_detached(canonicalBytes(payload), identityPriv);

  return encodeBase64Url(sig);
};

const verifyHandshake = async (
  payload: Record<string, unknown>,
  sigB64: string,
  identityPubB64: string
) => {
  try {
    const sodium = await getSodium();
    const sig = decodeBase64Url(sigB64);
    const verifyKey = decodeBase64Url(identityPubB64);

    const valid = sodium.crypto_sign_verify_detached(sig, canonicalBytes(payload), verifyKey);
    countSessionStage("signature", valid ? "success" : "rejected");

    return valid;
  } catch {
    return false;
  }
};

const formatSafetyNumber = (encoded: string) => {
  const compact = encoded.replace(/[^a-zA-Z0-9]/g, "");
  const a = compact.slice(0, 6);
  const b = compact.slice(6, 11);
  const c = compact.slice(11, 17);

  return [a, b, c].filter(Boolean).join("-");
};

const emitFriendLifecycleTrace = (
  event: string,
  payload: {
    traceId?: string;
    frameType: "friend_req" | "friend_accept" | "friend_decline" | "profile_update";
    convId?: string;
    friendId?: string;
    profileId?: string;
    stage?: string;
    [key: string]: unknown;
  }
) => {
  emitFlowTraceLog({
    event,
    source: "sync:friendLifecycle",
    ...payload,
    traceId: payload.traceId,
    frameType: payload.frameType,
    convId: payload.convId ?? null,
    friendId: payload.friendId ?? null,
    profileId: payload.profileId ?? null,
  });
};

const computeSafetyNumber = async (identityA: string, identityB: string) => {
  const sodium = await getSodium();
  const a = decodeBase64Url(identityA);
  const b = decodeBase64Url(identityB);

  const pair = [a, b].sort((lhs, rhs) => {
    const la = lhs.length;
    const lb = rhs.length;
    const min = Math.min(la, lb);

    for (let i = 0; i < min; i += 1) {
      if (lhs[i] !== rhs[i]) return lhs[i] - rhs[i];
    }

    return la - lb;
  });

  const hash = sodium.crypto_generichash(16, new Uint8Array([...pair[0], ...pair[1]]));

  return formatSafetyNumber(encodeBase64Url(hash));
};

const resolveFriendByIdentity = async (identityPub?: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();

  if (!identityPub) return null;
  const profiles = await listProfiles(context?.vault);
  const exact = profiles.find((profile) => profile.identityPub === identityPub);

  if (exact) return exact;

  try {
    const friendId = computeFriendId(decodeBase64Url(identityPub));

    return profiles.find((profile) => profile.friendId === friendId) ?? null;
  } catch {
    return null;
  }
};

const PROFILE_AVATAR_SYNC_MAX_BYTES = 512 * 1024;

const applyProfileUpdate = async (payload: ProfileUpdateFrame, existing: UserProfile | null, context?: ReceiveContext,
  application?: AuthenticatedProfileApplication, ownAccount = false, completeStale = false) => {
  context?.vault.assertLocal();

  if (!existing || (ownAccount ? existing.kind !== "user" : existing.kind !== "friend" || existing.friendStatus !== "normal")) return false;

  const incomingTs = Number(payload.ts);

  if (!Number.isFinite(incomingTs)) return false;
  const staleMetadata = incomingTs <= Number(existing.profileUpdatedAt ?? 0);

  if (staleMetadata && !completeStale) {
    emitFriendLifecycleTrace("friendLifecycle:dropped", {
      frameType: "profile_update", stage: "applyProfileUpdate:stale-metadata",
    });
    return false;
  }

  const incomingPresence = payload.profile.presence;

  const presence =
    incomingPresence &&
      isPresenceStatus(incomingPresence.status) &&
      Number.isFinite(incomingPresence.updatedAt) &&
      (completeStale ? incomingPresence.updatedAt <= Date.now() + HANDSHAKE_NONCE_TTL_MS &&
        incomingPresence.updatedAt >= Number(existing.presence?.updatedAt ?? 0) : incomingPresence.updatedAt <= incomingTs)
      ? {
        status: incomingPresence.status,
        updatedAt: Number(incomingPresence.updatedAt),
        ...(incomingPresence.status !== "offline" &&
          Number.isFinite(incomingPresence.expiresAt) &&
          Number(incomingPresence.expiresAt) > incomingPresence.updatedAt
          ? { expiresAt: Number(incomingPresence.expiresAt) }
          : {}),
      }
      : existing.presence;

  let avatarRef = existing.avatarRef;
  let avatarFile: File | undefined;
  const avatar = staleMetadata ? undefined : payload.profile.avatar;

  if (context && avatar && (typeof avatar.mime !== "string" || typeof avatar.data !== "string")) return false;

  if (avatar && typeof avatar.mime === "string" && typeof avatar.data === "string") {
    try {
      const bytes = decodeBase64Url(avatar.data);

      if (context && (!bytes.byteLength || bytes.byteLength > PROFILE_AVATAR_SYNC_MAX_BYTES)) return false;

      if (bytes.byteLength > 0 && bytes.byteLength <= PROFILE_AVATAR_SYNC_MAX_BYTES) {
        const file = new File([bytes], "profile-avatar", { type: avatar.mime });

        if (context && application) avatarFile = file;
        else avatarRef = await saveProfilePhoto(existing.id, file, context?.vault);
      }
    } catch (error) {
      if (context) return false;
      console.warn("[friend] ignored invalid profile avatar", error);
    }
  }

  const displayName = staleMetadata ? existing.displayName : payload.profile.displayName?.trim().slice(0, 80) || existing.displayName;

  const status =
    !staleMetadata && typeof payload.profile.status === "string"
      ? payload.profile.status.trim().slice(0, 190)
      : existing.status;

  const next: UserProfile = {
    ...existing,
    displayName,
    status,
    avatarRef,
    presence,
    profileUpdatedAt: staleMetadata ? existing.profileUpdatedAt : incomingTs,
    profileVcard: {
      ...(existing.profileVcard ?? {}),
      displayName,
      status,
      avatarRef,
      updatedAt: staleMetadata ? existing.profileVcard?.updatedAt : incomingTs,
    },
    updatedAt: Date.now(),
  };

  if (context && application) return commitAuthenticatedProfile(next, existing, application, context.vault, undefined, undefined, avatarFile);
  await saveProfile(next, context?.vault);

  return true;
};

const upsertFriendFromRequest = async (
  convId: string,
  payload: FriendRequestFrame, context?: ReceiveContext, application?: AuthenticatedProfileApplication
) => {
  context?.vault.assertLocal();

  if (!payload.from?.identityPub || !payload.from?.dhPub) return false;
  emitFriendLifecycleTrace("friendLifecycle:incoming-request:start", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId,
    stage: "upsertFriendFromRequest:start",
    hasDeviceId: Boolean(payload.from.deviceId),
    hasFriendCode: Boolean(payload.from.friendCode),
  });
  const privacyPrefs = await getPrivacyPrefs(context);
  const profiles = await listProfiles(context?.vault);

  const existing = profiles.find(
    (profile) =>
      profile.identityPub === payload.from.identityPub ||
      (profile.friendId &&
        profile.identityPub &&
        profile.identityPub === payload.from.identityPub)
  );

  if (!existing && privacyPrefs.autoRejectUnknownRequests) {
    console.info("[friend] auto-rejected unknown friend request");
    emitFriendLifecycleTrace("friendLifecycle:incoming-request:auto-rejected", {
      traceId: payload.traceId,
      frameType: payload.type,
      convId,
      stage: "upsertFriendFromRequest:auto-reject-unknown",
    });

    return context && application ? commitAuthenticatedProfile(null, null, application, context.vault) : true;
  }

  const identityBytes = decodeBase64Url(payload.from.identityPub);
  const friendId = computeFriendId(identityBytes);
  const now = Date.now();

  const decodedFriendCode =
    typeof payload.from.friendCode === "string" && payload.from.friendCode.trim()
      ? decodeFriendCodeV1(payload.from.friendCode)
      : null;

  const codeHints =
    decodedFriendCode && !("error" in decodedFriendCode)
      ? sanitizeRoutingHints({
        deviceId: decodedFriendCode.deviceId,
        onionAddr: decodedFriendCode.onionAddr,
        inboxWriteToken: decodedFriendCode.inboxWriteToken,
      })
      : undefined;

  const resolvedDeviceId =
    payload.from.deviceId ??
    (decodedFriendCode && !("error" in decodedFriendCode) ? decodedFriendCode.deviceId : undefined) ??
    existing?.primaryDeviceId;

  const routingHints = sanitizeRoutingHints({
    deviceId: resolvedDeviceId,
    onionAddr: codeHints?.onionAddr ?? existing?.routingHints?.onionAddr,
    inboxWriteToken:
      codeHints?.inboxWriteToken ?? existing?.routingHints?.inboxWriteToken,
  });

  const reachability = resolvedDeviceId
    ? { status: "ok" as const }
    : {
      status: "unreachable" as const,
      lastError: "Missing deviceId in friend request",
    };

  const incomingTs = payload.ts ?? now;
  const existingVcard = existing?.profileVcard;

  const shouldUpdateVcard =
    !existingVcard?.updatedAt || existingVcard.updatedAt <= incomingTs;

  const nextVcard = (() => {
    if (!shouldUpdateVcard && existingVcard) return existingVcard;

    const next: UserProfile["profileVcard"] = {
      ...(existingVcard ?? {}),
      updatedAt: incomingTs,
    };

    if (payload.profile?.displayName !== undefined) {
      next.displayName = payload.profile.displayName;
    }

    if (payload.profile?.status !== undefined) {
      next.status = payload.profile.status;
    }

    if (payload.profile?.avatarRef !== undefined) {
      next.avatarRef = payload.profile.avatarRef;
    }

    if (payload.from?.friendCode !== undefined) {
      next.friendCode = payload.from.friendCode;
    }

    return next;
  })();

  const existingStatus = existing?.friendStatus;
  const isMutualRequest = existingStatus === "request_out";

  const preserveExistingStatus =
    existingStatus === "hidden" ||
    existingStatus === "blocked" ||
    (existingStatus === "normal" && payload.reconnect !== true);

  const nextFriendStatus = isMutualRequest ? "normal" : preserveExistingStatus ? existingStatus : "request_in";
  const shouldMarkPending = nextFriendStatus === "request_in";

  const shouldAcknowledgeRequest =
    nextFriendStatus === "normal" &&
    (isMutualRequest || (existingStatus === "normal" && payload.reconnect !== true));

  const forceHidden = nextFriendStatus === "blocked" || nextFriendStatus === "hidden";

  const profile: UserProfile = {
    id: existing?.id ?? createId(),
    friendId,
    displayName: payload.profile?.displayName ?? existing?.displayName ?? "Friend",
    status: payload.profile?.status ?? existing?.status ?? "",
    presence:
      payload.profile?.presence && isPresenceStatus(payload.profile.presence.status)
        ? payload.profile.presence
        : existing?.presence,
    theme: existing?.theme ?? "dark",
    kind: "friend",
    friendStatus: nextFriendStatus,
    friendControlTs: Math.max(existing?.friendControlTs ?? 0, incomingTs),
    friendKeysAuthenticated: { identityPub: payload.from.identityPub, dhPub: payload.from.dhPub },
    isFavorite: existing?.isFavorite ?? false,
    identityPub: payload.from.identityPub,
    dhPub: payload.from.dhPub,
    routingHints: routingHints ?? existing?.routingHints,
    primaryDeviceId: resolvedDeviceId,
    trust: existing?.trust ?? { pinnedAt: now, status: "trusted" },
    verification: existing?.verification ?? { status: "unverified" },
    reachability,
    profileVcard: nextVcard,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const currentUserId = await resolveLocalUserId(context);

  if (!currentUserId) return false;
  const requestConvId = payload.convId ?? convId;
  let convs = await listConversations(context?.vault);
  const requestedConversation = convs.find((item) => item.id === requestConvId);

  if (requestedConversation && (requestedConversation.type === "group" ||
    requestedConversation.participants.length !== 2 ||
    !requestedConversation.participants.includes(profile.id))) return false;

  if (!context || !application) await saveProfile(profile, context?.vault);
  emitFriendLifecycleTrace(context && application ? "friendLifecycle:incoming-request:profile-prepared" : "friendLifecycle:incoming-request:profile-saved", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId,
    friendId,
    profileId: profile.id,
    stage: context && application ? "upsertFriendFromRequest:profile-prepared" : "upsertFriendFromRequest:profile-saved",
    nextFriendStatus,
    shouldMarkPending,
    primaryDeviceId: resolvedDeviceId ?? null,
    hasOnionAddr: Boolean(routingHints?.onionAddr),
  });

  let staleConversations: Conversation[] = [];

  if (existingStatus === "deleted") {
    staleConversations = convs.filter(
      (conv) =>
        !(conv.type === "group" || conv.participants.length > 2) &&
        conv.participants.includes(profile.id)
    );

    if (!context || !application) for (const conversation of staleConversations) {
      await deleteConversationData(conversation.id, context?.vault);
    }

    convs = convs.filter(
      (conv) => !staleConversations.some((stale) => stale.id === conv.id)
    );
  }

  const existingConv =
    convs.find((conv) => conv.id === requestConvId) ??
    convs.find(
      (conv) =>
        !(conv.type === "group" || conv.participants.length > 2) &&
        conv.participants.includes(profile.id)
    ) ??
    null;

  if (existingConv) {
    const updated: Conversation = {
      ...existingConv,
      name: profile.displayName,
      pendingAcceptance: shouldMarkPending ? true : false,
      pendingOutgoing: shouldMarkPending ? false : false,
      pendingFriendResponse: shouldAcknowledgeRequest ? "accept" : undefined,
      friendshipAccepted: nextFriendStatus === "normal",
      pendingFriendTarget: undefined,
      blocked: nextFriendStatus === "blocked",
      hidden: forceHidden ? true : shouldMarkPending ? false : existingConv.hidden,
      lastTs: Math.max(existingConv.lastTs, payload.ts ?? now),
      lastMessage: shouldMarkPending ? "친구 요청" : "친구 요청을 수락했습니다.",
    };

    if (context && application) await commitAuthenticatedProfile(profile, existing ?? null, application, context.vault,
      updated, existingConv, undefined, staleConversations);
    else await saveConversation(updated, context?.vault);
    emitFriendLifecycleTrace("friendLifecycle:incoming-request:conversation-updated", {
      traceId: payload.traceId,
      frameType: payload.type,
      convId: requestConvId,
      friendId,
      profileId: profile.id,
      stage: "upsertFriendFromRequest:conversation-updated",
      pendingAcceptance: updated.pendingAcceptance,
      pendingOutgoing: updated.pendingOutgoing,
      pendingFriendResponse: updated.pendingFriendResponse,
      hidden: updated.hidden,
    });

    return true;
  }

  if (!shouldMarkPending) {
    emitFriendLifecycleTrace("friendLifecycle:incoming-request:no-conversation-created", {
      traceId: payload.traceId,
      frameType: payload.type,
      convId: requestConvId,
      friendId,
      profileId: profile.id,
      stage: "upsertFriendFromRequest:no-conversation-created",
      reason: "no-pending-acceptance",
    });

    return context && application ? commitAuthenticatedProfile(profile, existing ?? null, application, context.vault,
      undefined, undefined, undefined, staleConversations) : true;
  }

  const newConv: Conversation = {
    id: requestConvId,
    type: "direct",
    name: profile.displayName ?? "Friend",
    pinned: false,
    unread: 0,
    hidden: false,
    muted: false,
    blocked: false,
    pendingAcceptance: true,
    pendingOutgoing: false,
    pendingFriendResponse: undefined,
    lastTs: payload.ts ?? now,
    lastMessage: "친구 요청",
    participants: [currentUserId, profile.id],
  };

  if (context && application) await commitAuthenticatedProfile(profile, existing ?? null, application, context.vault,
    newConv, staleConversations.find(item => item.id === newConv.id) ?? null, undefined, staleConversations);
  else await saveConversation(newConv, context?.vault);
  emitFriendLifecycleTrace("friendLifecycle:incoming-request:conversation-created", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId: newConv.id,
    friendId,
    profileId: profile.id,
    stage: "upsertFriendFromRequest:conversation-created",
    pendingAcceptance: newConv.pendingAcceptance,
    pendingOutgoing: newConv.pendingOutgoing,
  });

  return true;
};

const applyFriendResponse = async (convId: string, payload: FriendResponseFrame, context?: ReceiveContext, application?: AuthenticatedProfileApplication) => {
  context?.vault.assertLocal();

  if (!payload.from?.identityPub || !payload.from?.dhPub) return false;
  let existing = await resolveFriendByIdentity(payload.from.identityPub, context);
  let recoveredFromPendingRequest = false;
  let previousProfile = existing;

  if (!existing) {
    const [profiles, conversations] = await Promise.all([
      listProfiles(context?.vault),
      listConversations(context?.vault),
    ]);

    const pendingConversation = conversations.find(
      (conversation) =>
        conversation.id === convId &&
        conversation.type !== "group" &&
        conversation.participants.length === 2 &&
        conversation.pendingOutgoing === true
    );

    const pendingTarget = pendingConversation?.pendingFriendTarget;
    let responseFriendId: string | null = null;

    try {
      responseFriendId = computeFriendId(decodeBase64Url(payload.from.identityPub));
    } catch {
      responseFriendId = null;
    }

    const targetMatches =
      pendingTarget &&
      responseFriendId === pendingTarget.friendId &&
      payload.from.identityPub === pendingTarget.identityPub &&
      payload.from.dhPub === pendingTarget.dhPub;

    if (pendingConversation && pendingTarget && targetMatches) {
      const now = Date.now();

      const participantId =
        pendingTarget.profileId ||
        pendingConversation.participants.find(
          (participantId) => !profiles.some(
            (profile) => profile.id === participantId && profile.kind === "user"
          )
        );

      const participantProfile = participantId
        ? profiles.find((profile) => profile.id === participantId && profile.kind === "friend")
        : undefined;

      const participantMatches =
        !participantProfile ||
        (participantProfile.friendId === pendingTarget.friendId &&
          (!participantProfile.identityPub ||
            participantProfile.identityPub === payload.from.identityPub) &&
          (!participantProfile.dhPub || participantProfile.dhPub === payload.from.dhPub));

      if (participantMatches) {
        previousProfile = participantProfile ?? null;
        existing = participantProfile ?? {
          id: pendingTarget.profileId,
          friendId: pendingTarget.friendId,
          displayName:
            payload.profile?.displayName ?? `Friend ${pendingTarget.friendId.slice(0, 6)}`,
          status: payload.profile?.status ?? "",
          theme: "dark",
          kind: "friend",
          friendStatus: "request_out",
          identityPub: pendingTarget.identityPub,
          dhPub: pendingTarget.dhPub,
          trust: { pinnedAt: now, status: "trusted" },
          verification: { status: "unverified" },
          createdAt: now,
          updatedAt: now,
        };
        recoveredFromPendingRequest = true;
      }
    }
  }

  if (!existing) {
    emitFriendLifecycleTrace("friendLifecycle:incoming-response:friend-not-found", {
      traceId: payload.traceId,
      frameType: payload.type,
      convId,
      stage: "applyFriendResponse:friend-not-found",
    });

    return false;
  }

  emitFriendLifecycleTrace("friendLifecycle:incoming-response:start", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId,
    friendId: existing.friendId,
    profileId: existing.id,
    stage: "applyFriendResponse:start",
    recoveredFromPendingRequest,
  });

  // A peer's proof of key ownership cannot authorize our local approval or unblock.
  if (payload.type === "friend_accept" && existing.friendStatus !== "request_out" &&
    existing.friendStatus !== "normal") return false;
  const convs = await listConversations(context?.vault);
  const requestedConversation = convs.find((item) => item.id === convId);

  if (requestedConversation && (requestedConversation.type === "group" ||
    requestedConversation.participants.length !== 2 ||
    !requestedConversation.participants.includes(existing.id))) return false;
  const now = Date.now();
  const friendStatus = payload.type === "friend_accept" ? "normal" : "blocked";

  const decodedFriendCode =
    typeof payload.from.friendCode === "string" && payload.from.friendCode.trim()
      ? decodeFriendCodeV1(payload.from.friendCode)
      : null;

  const codeHints =
    decodedFriendCode && !("error" in decodedFriendCode)
      ? sanitizeRoutingHints({
        deviceId: decodedFriendCode.deviceId,
        onionAddr: decodedFriendCode.onionAddr,
        inboxWriteToken: decodedFriendCode.inboxWriteToken,
      })
      : undefined;

  const resolvedDeviceId =
    payload.from.deviceId ??
    (decodedFriendCode && !("error" in decodedFriendCode) ? decodedFriendCode.deviceId : undefined) ??
    existing.primaryDeviceId;

  const nextProfile: UserProfile = {
    ...existing,
    displayName: payload.profile?.displayName ?? existing.displayName,
    status: payload.profile?.status ?? existing.status,
    presence:
      payload.profile?.presence && isPresenceStatus(payload.profile.presence.status)
        ? payload.profile.presence
        : existing.presence,
    avatarRef: existing.avatarRef,
    friendStatus,
    friendControlTs: Math.max(existing.friendControlTs ?? 0, payload.ts ?? now),
    friendKeysAuthenticated: { identityPub: payload.from.identityPub, dhPub: payload.from.dhPub },
    primaryDeviceId: resolvedDeviceId,
    routingHints: sanitizeRoutingHints({
      deviceId: resolvedDeviceId,
      onionAddr: codeHints?.onionAddr ?? existing.routingHints?.onionAddr,
      inboxWriteToken:
        codeHints?.inboxWriteToken ?? existing.routingHints?.inboxWriteToken,
    }),
    profileVcard: payload.profile
      ? {
        displayName: payload.profile.displayName,
        status: payload.profile.status,
        avatarRef: payload.profile.avatarRef,
        friendCode: payload.from.friendCode ?? existing.profileVcard?.friendCode,
        updatedAt: payload.ts ?? now,
      }
      : existing.profileVcard,
    updatedAt: now,
  };

  if (!context || !application) await saveProfile(nextProfile, context?.vault);
  emitFriendLifecycleTrace(context && application ? "friendLifecycle:incoming-response:profile-prepared" : "friendLifecycle:incoming-response:profile-saved", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId,
    friendId: existing.friendId,
    profileId: existing.id,
    stage: context && application ? "applyFriendResponse:profile-prepared" : "applyFriendResponse:profile-saved",
    friendStatus,
    primaryDeviceId: resolvedDeviceId ?? null,
    hasOnionAddr: Boolean(codeHints?.onionAddr ?? existing.routingHints?.onionAddr),
  });

  const conv =
    requestedConversation ??
    convs.find(
      (item) =>
        !(item.type === "group" || item.participants.length > 2) &&
        item.participants.includes(existing.id)
    ) ??
    null;

  if (!conv) return context && application ? commitAuthenticatedProfile(nextProfile,
    previousProfile, application, context.vault) : true;

  const nextConversation: Conversation = {
    ...conv,
    name: payload.profile?.displayName ?? existing.displayName,
    pendingAcceptance: false,
    pendingOutgoing: false,
    pendingFriendResponse: undefined,
    friendshipAccepted: payload.type === "friend_accept",
    pendingFriendTarget: undefined,
    blocked: friendStatus === "blocked",
    hidden: friendStatus === "blocked",
    lastTs: Math.max(conv.lastTs, payload.ts ?? now),
    lastMessage:
      payload.type === "friend_accept"
        ? "친구 요청이 수락되었습니다."
        : "친구 요청이 거절되었습니다.",
  };

  if (context && application) await commitAuthenticatedProfile(nextProfile, previousProfile,
    application, context.vault, nextConversation, conv);
  else await saveConversation(nextConversation, context?.vault);
  emitFriendLifecycleTrace("friendLifecycle:incoming-response:conversation-updated", {
    traceId: payload.traceId,
    frameType: payload.type,
    convId: conv.id,
    friendId: existing.friendId,
    profileId: existing.id,
    stage: "applyFriendResponse:conversation-updated",
    friendStatus,
    hidden: friendStatus === "blocked",
  });

  return true;
};

export const handleIncomingFriendFrame = async (
  payload: FriendControlFrame,
  options: {
    trustedEnvelope?: boolean;
    diagnosticPacketId?: string;
    localFriendCode?: string;
    replyRoute?: IncomingReplyRoute;
    application?: AuthenticatedProfileApplication;
  } = {}, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!isFriendControlFrame(payload)) return false;

  if (!options.trustedEnvelope) {
    if (!isFriendControlFrameFresh(payload)) {
      console.warn("[friend] dropped control frame: stale timestamp", { type: payload.type });
      emitFriendLifecycleTrace("friendLifecycle:dropped", {
        traceId: payload.traceId,
        frameType: payload.type,
        convId: payload.convId,
        stage: "handleIncomingFriendFrame:stale-timestamp",
      });

      return false;
    }

    const verified = await verifyFriendControlFrameSignature(payload);

    if (!verified) {
      console.warn("[friend] dropped control frame: invalid signature", { type: payload.type });
      emitFriendLifecycleTrace("friendLifecycle:dropped", {
        traceId: payload.traceId,
        frameType: payload.type,
        convId: payload.convId,
        stage: "handleIncomingFriendFrame:invalid-signature",
      });

      return false;
    }
  }

  const protocolCheck = await verifyFriendControlFrameProtocol(payload, {
    localFriendCode: options.localFriendCode,
  });

  if (!protocolCheck.ok) {
    console.warn("[friend] dropped control frame: invalid protocol", {
      type: payload.type,
      reason: protocolCheck.reason,
    });
    emitFriendLifecycleTrace("friendLifecycle:dropped", {
      traceId: payload.traceId,
      frameType: payload.type,
      convId: payload.convId,
      stage: "handleIncomingFriendFrame:invalid-protocol",
      reason: protocolCheck.reason ?? null,
    });

    return false;
  }

  let application = options.application;

  if (context && !application) {
    const sodium = await getSodium();
    const eventHash = encodeBase64Url(sodium.crypto_generichash(32, canonicalBytes(payload)));
    application = { eventId: eventHash, eventHash, convId: payload.convId ?? "", lamport: 0, candidate: false };
  }

  if (options.diagnosticPacketId) firstMessageMeasurement.stage(options.diagnosticPacketId, "verified");

  const handled = await withFriendControlLock(payload.from.identityPub, async () => {
    if (context && application && !application.candidate) {
      await context.vault.assertMain();

      if ((await context.vault.db.meta.get(`friend_control_v1:${application.eventId}`))?.value === application.eventHash) return true;
    }

    const existing = await resolveFriendByIdentity(payload.from.identityPub, context);

    if (existing && (existing.identityPub && existing.identityPub !== payload.from.identityPub ||
      existing.dhPub && existing.dhPub !== payload.from.dhPub)) return false;
    const incomingTimestamp = Number(payload.ts);
    const existingTimestamp = Number(existing?.friendControlTs);

    const isIdempotentFinalResponse =
      Number.isFinite(incomingTimestamp) &&
      Number.isFinite(existingTimestamp) &&
      incomingTimestamp === existingTimestamp &&
      ((payload.type === "friend_accept" && existing?.friendStatus === "normal") ||
        (payload.type === "friend_decline" && existing?.friendStatus === "blocked"));

    if (isIdempotentFinalResponse) {
      const convId = payload.convId ?? "";

      return applyFriendResponse(convId, payload, context, application);
    }

    if (
      Number.isFinite(payload.ts) &&
      Number.isFinite(existing?.friendControlTs) &&
      Number(existing?.friendControlTs) >= Number(payload.ts)
    ) {
      console.warn("[friend] dropped control frame: replayed timestamp", { type: payload.type });
      emitFriendLifecycleTrace("friendLifecycle:dropped", {
        traceId: payload.traceId,
        frameType: payload.type,
        convId: payload.convId,
        stage: "handleIncomingFriendFrame:replayed-timestamp",
      });

      return false;
    }

    if (payload.type === "friend_req") {
      const convId = payload.convId ?? createId();

      return upsertFriendFromRequest(convId, payload, context, application);
    }

    if (payload.type === "friend_accept" || payload.type === "friend_decline") {
      const convId = payload.convId ?? "";

      return applyFriendResponse(convId, payload, context, application);
    }

    if (payload.type === "profile_update") {
      return applyProfileUpdate(payload, existing, context, application);
    }

    return false;
  });

  if (handled && !options.trustedEnvelope) {
    await refreshAuthenticatedFriendReplyRoute(payload, options.replyRoute, context);
  }

  if (handled && options.diagnosticPacketId) firstMessageMeasurement.stage(options.diagnosticPacketId, "stored");

  return handled;
};

const verifyHandshakeCompat = async (
  payloadWithCaps: Record<string, unknown>,
  legacyPayload: Record<string, unknown>,
  sigB64: string,
  identityPubB64: string,
  hasCaps: boolean
) => {
  const withCaps = await verifyHandshake(payloadWithCaps, sigB64, identityPubB64);

  if (withCaps) return true;

  if (hasCaps) return false;

  return verifyHandshake(legacyPayload, sigB64, identityPubB64);
};

const toBytes = (frame: Frame) => textEncoder.encode(JSON.stringify(frame));

const controlPayload = (frame: Frame) => {
  const { sig, ...payload } = frame;
  void sig;

  return payload;
};

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

const getSinceMap = (convId?: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();

  if (!convId) {
    const since: Record<string, number> = {};
    perAuthorLamportSeen.forEach((value, key) => {
      const prefix = ownerKey("", context);

      if (key.startsWith(prefix)) since[key.slice(prefix.length)] = value;
    });

    return since;
  }

  const perConv = perConvLamportSeen.get(ownerKey(convId, context));

  if (!perConv) return {};
  const since: Record<string, number> = {};
  perConv.forEach((value, key) => {
    since[key] = value;
  });

  return since;
};

const updateLamportSeen = (convId: string, authorDeviceId: string, lamport: number, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const prevAuthor = perAuthorLamportSeen.get(ownerKey(authorDeviceId, context)) ?? 0;

  if (lamport > prevAuthor) setReceiveCache(context, perAuthorLamportSeen, ownerKey(authorDeviceId, context), lamport);

  let perConv = perConvLamportSeen.get(ownerKey(convId, context));

  if (!perConv) {
    perConv = new Map();
    setReceiveCache(context, perConvLamportSeen, ownerKey(convId, context), perConv);
  }

  const prevConv = perConv.get(authorDeviceId) ?? 0;

  if (lamport > prevConv) perConv.set(authorDeviceId, lamport);
};

const getLamportSeen = (convId: string, authorDeviceId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const perConv = perConvLamportSeen.get(ownerKey(convId, context));

  return perConv?.get(authorDeviceId) ?? 0;
};

const buildNextMap = (events: Pick<EnvelopeEvent, "authorDeviceId" | "lamport">[]) => {
  const next: Record<string, number> = {};

  for (const event of events) {
    const prev = next[event.authorDeviceId] ?? 0;

    if (event.lamport > prev) {
      next[event.authorDeviceId] = event.lamport;
    }
  }

  return next;
};

const toEnvelopeEvent = (event: Pick<EnvelopeEvent, "eventId" | "convId" | "authorDeviceId" | "lamport" | "ts"> & { envelopeFormat?: string; envelopeJson?: string }) => ({
  eventId: event.eventId,
  convId: event.convId,
  authorDeviceId: event.authorDeviceId,
  lamport: event.lamport,
  ts: event.ts,
  envelopeJson: legacyEventJson(event),
});

const sortEventsDeterministic = (events: EnvelopeEvent[]) =>
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;

    if (a.authorDeviceId !== b.authorDeviceId) {
      return a.authorDeviceId.localeCompare(b.authorDeviceId);
    }

    return a.lamport - b.lamport;
  });

const resolveLegacyKey = async (convId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer?.dhPub) return null;
  const dhPriv = await getDhPrivateKey(context);
  const theirDhPub = decodeBase64Url(peer.dhPub);
  const friendKeyId = peer.friendKeyId ?? peer.directAddr ?? convId;
  const pskBytes = await getFriendPsk(friendKeyId, context);
  const legacyContextBytes = textEncoder.encode(`direct:${friendKeyId}`);

  return deriveConversationKey(dhPriv, theirDhPub, pskBytes, legacyContextBytes);
};

const resolveRatchetBaseKey = async (peerConvId: string, contextConvId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(peerConvId, context));

  if (!peer?.dhPub) return null;

  if (peer.deviceAuthorizationVersion === 2) {
    if (!context || !await isDeviceSyncAllowed(peerConvId, "ratchet-key", context) ||
      contextConvId !== deviceChannelIdentity(getOrCreateDeviceId(context), peer.peerDeviceId ?? "")) return null;

    return freshSessions.get(ownerKey(peerConvId, context))?.inbound?.key ?? null;
  }

  // Owner-less protocol adapters are excluded by the Desktop entry-point guard.
  if (!context) return deriveConversationKey(await getDhPrivateKey(), decodeBase64Url(peer.dhPub),
    await getFriendPsk(peer.friendKeyId ?? peerConvId), textEncoder.encode(`conv:${contextConvId}`));
  await authenticatedFriendIdentity(peerConvId, context);

  return freshSessions.get(ownerKey(peerConvId, context))?.inbound?.key ?? null;
};

const getPeerVerifyKey = async (convId: string, authorDeviceId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const localDeviceId = getOrCreateDeviceId(context);

  if (authorDeviceId === localDeviceId) {
    return getIdentityPublicKey(context);
  }

  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer?.identityPub) return null;

  if ((peer.kind === "device" || peer.deviceAuthorizationVersion === 2) && !await isDeviceSyncAllowed(convId, "verify-key", context)) return null;

  return decodeBase64Url(peer.identityPub);
};

const applyDecryptedBody = async (
  peerConvId: string,
  conv: Conversation | null,
  envelope: Envelope,
  body: unknown,
  diagnosticContext?: DeliveryContext, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!body || typeof body !== "object") return;

  const currentUserId = await resolveLocalUserId(context);
  const senderProfile = await resolveSenderProfile(peerConvId, conv, currentUserId, context);
  const senderId = senderProfile?.id ?? null;

  if (senderProfile) {
    await repairDirectConversationPeerBinding(peerConvId, senderProfile, currentUserId, context);
  }

  if (isGroupEventPayload(body)) {
    if (context) throw new Error("GROUP_SHORT_COMMIT_REQUIRED");

    return applyGroupEvent(body, senderId, currentUserId, context);
  }

  const typed = body as {
    type?: string;
    phase?: string;
    ownerId?: string;
    idx?: number;
    total?: number;
    chunkSize?: number;
    size?: number;
    mime?: string;
    b64?: string;
    media?: unknown;
    kind?: string;
    convId?: string;
    cursorTs?: number;
    anchorMsgId?: string;
    msgId?: string;
    eventHash?: string;
    ts?: number;
    clientBatchId?: string;
  };

  if (typed.type === "media" && typed.phase === "chunk") {
    if (
      typeof typed.ownerId !== "string" ||
      typeof typed.b64 !== "string" ||
      typeof typed.mime !== "string" ||
      !Number.isInteger(typed.idx) ||
      !Number.isInteger(typed.total) ||
      !Number.isInteger(typed.chunkSize) ||
      !Number.isFinite(typed.size)
    ) {
      console.warn("[sync] invalid media chunk metadata");
      emitFlowTraceLog({
        event: "mediaTransfer:receive:rejected",
        level: "warn",
        source: "syncEngine.applyDecryptedBody",
        operationId: typeof typed.ownerId === "string" ? typed.ownerId : undefined,
        chunkIndex: typed.idx,
        totalChunks: typed.total,
        declaredBytes: typed.size,
        mime: typed.mime,
        reason: "invalid-metadata",
      });

      return;
    }

    try {
      const bytes = decodeBase64Url(typed.b64);

      const result = await saveReceivedMessageMediaChunk({
        ownerId: typed.ownerId,
        idx: typed.idx as number,
        total: typed.total as number,
        chunkSize: typed.chunkSize as number,
        size: typed.size as number,
        mime: typed.mime,
        bytes,
      }, context?.vault);

      emitFlowTraceLog({
        event: result.complete
          ? "mediaTransfer:receive:complete"
          : "mediaTransfer:receive:chunk-stored",
        source: "syncEngine.applyDecryptedBody",
        operationId: typed.ownerId,
        chunkIndex: typed.idx,
        totalChunks: result.total,
        receivedChunks: result.received,
        chunkBytes: bytes.byteLength,
        declaredBytes: typed.size,
        chunkSize: typed.chunkSize,
        mime: typed.mime,
        complete: result.complete,
      });

      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "Media manifest is missing") {
        if (context) throw error; // Existing authenticated event retains the operation until its manifest arrives.
        const pending = pendingMediaChunks.get(ownerKey(typed.ownerId, context)) ?? [];

        if (!pending.some((chunk) => chunk.idx === typed.idx) && pending.length < MAX_PENDING_MEDIA_CHUNKS) {
          pending.push(body as Record<string, unknown>);
          setReceiveCache(context, pendingMediaChunks, ownerKey(typed.ownerId, context), pending);
        }

        emitFlowTraceLog({
          event: "mediaTransfer:receive:deferred",
          source: "syncEngine.applyDecryptedBody",
          operationId: typed.ownerId,
          chunkIndex: typed.idx,
          totalChunks: typed.total,
          reason: "manifest-pending",
        });

        return;
      }

      console.warn("[sync] media chunk rejected", error);

      if (context) throw error;
      emitFlowTraceLog({
        event: "mediaTransfer:receive:failed",
        level: "error",
        source: "syncEngine.applyDecryptedBody",
        operationId: typed.ownerId,
        chunkIndex: typed.idx,
        totalChunks: typed.total,
        declaredBytes: typed.size,
        mime: typed.mime,
        errorDetail: error,
      });
    }

    return true;
  }

  if (typed.type === "rcpt" && typed.kind === "delivered") {
    if (!context || envelope.header.rk?.v !== 2 || !senderProfile?.identityPub || !conv ||
      typeof typed.msgId !== "string" || typeof typed.convId !== "string" || typeof typed.eventHash !== "string" ||
      typed.convId !== peerConvId || !await applyAuthenticatedDeliveredReceipt({ messageId: typed.msgId,
        convId: peerConvId, eventHash: typed.eventHash, peerIdentityPub: senderProfile.identityPub }, context.vault)) {
      throw new Error("INVALID_APPLICATION_DELIVERY_RECEIPT");
    }

    return true;
  }

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
    }, context?.vault);
    firstMessageMeasurement.authenticatedRead(peerConvId, typed.anchorMsgId ?? typed.msgId);

    return true;
  }

  if (typed.type === "msg") {
    await applyMessageEvent(
      conv,
      envelope,
      body as { type: "msg"; text: string; media?: unknown; clientBatchId?: string },
      senderId ?? currentUserId ?? envelope.header.authorDeviceId,
      senderProfile?.friendStatus === "deleted",
      diagnosticContext, context
    );
    const pending = typed.media && typeof typed.media === "object" ? pendingMediaChunks.get(ownerKey((body as { media?: { ownerId?: unknown } }).media?.ownerId as string, context)) : undefined;

    if (pending?.length) {
      deleteReceiveCache(context, pendingMediaChunks, ownerKey((body as { media?: { ownerId?: string } }).media?.ownerId ?? "", context));

      for (const deferredChunk of pending) {
        await applyDecryptedBody(peerConvId, conv, envelope, deferredChunk, undefined, context);
      }
    }

    return true;
  }

  if (typed.type === "friend_req") {
    const authenticatedPeerIdentity = peerContexts.get(ownerKey(peerConvId, context))?.identityPub;
    const claimedIdentity = (body as FriendControlFrame).from?.identityPub;

    if (!authenticatedPeerIdentity || claimedIdentity !== authenticatedPeerIdentity) {
      console.warn("[friend] dropped control frame: envelope identity mismatch", { peerConvId });

      return;
    }

    return handleIncomingFriendFrame(
      { ...(body as FriendControlFrame), ts: typed.ts ?? envelope.header.ts },
      { trustedEnvelope: true }, context
    );
  }

  if (
    typed.type === "friend_accept" ||
    typed.type === "friend_decline" ||
    typed.type === "profile_update"
  ) {
    const authenticatedPeerIdentity = peerContexts.get(ownerKey(peerConvId, context))?.identityPub;
    const claimedIdentity = (body as FriendControlFrame).from?.identityPub;

    if (!authenticatedPeerIdentity || claimedIdentity !== authenticatedPeerIdentity) {
      console.warn("[friend] dropped control frame: envelope identity mismatch", { peerConvId });

      return;
    }

    return handleIncomingFriendFrame(
      { ...(body as FriendControlFrame), ts: typed.ts ?? envelope.header.ts },
      { trustedEnvelope: true }, context
    );
  }

  if (typed.type === "contact") {
    return applyContactEvent(
      peerConvId,
      body as { type: "contact"; profile: Partial<UserProfile> }, context
    );
  }

  if (typed.type === "conv") {
    return applyConversationEvent(peerConvId, body as { type: "conv"; conv: Conversation }, context);
  }

  if (typed.kind === "ROLE_CHANGE") {
    const roleEvent = body as RoleChangeEvent;

    if (canUseRoleEvents(getPeerCaps(peerConvId, context))) {
      await updateFromRoleEvent(roleEvent, context);

      return true;
    }

    if (!hasKnownPeerCaps(peerConvId, context)) {
      if (context) throw new Error("PEER_CAPABILITY_PENDING");
      deferRoleChangeEvent(peerConvId, envelope.header.eventId, roleEvent, context);
      console.info("[sync] role change deferred: peer caps unconfirmed", {
        convId: peerConvId,
        eventId: envelope.header.eventId,
      });

      return;
    }

    if (!canUseRoleEvents(getPeerCaps(peerConvId, context))) {
      console.warn("[sync] role change dropped: peer capability missing", {
        convId: peerConvId,
        capsState: "known_unsupported",
      });

      return;
    }
  }
};

const applyMessageEvent = async (
  conv: Conversation | null,
  envelope: Envelope,
  body: { type: "msg"; text: string; media?: unknown; clientBatchId?: string },
  senderId: string,
  reconnectRequired = false,
  diagnosticContext?: DeliveryContext, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!conv) return;
  const lastMessage = typeof body.text === "string" ? body.text : "";
  const built = buildReceivedText(conv, envelope, lastMessage, senderId, reconnectRequired);

  const media = body.media === undefined
    ? undefined
    : parseIncomingMediaRef(body.media, envelope.header.friendDeliveryId ?? envelope.header.eventId) ?? undefined;

  const message: Message = {
    ...built.message,
    media,
    clientBatchId: body.clientBatchId,
  };

  if (body.media === undefined) {
    firstMessageMeasurement.stage(envelope.header.eventId, "decrypted", diagnosticContext);
    firstMessageMeasurement.messageAuthenticated(envelope.header.eventId);
  }

  await saveMessage(message, context?.vault);
  await saveConversation(built.conversation, context?.vault);
};

const applyContactEvent = async (
  peerConvId: string,
  body: { type: "contact"; v?: 2; profile: Partial<UserProfile> }, context?: ReceiveContext,
  application?: AuthenticatedProfileApplication
) => {
  context?.vault.assertLocal();

  if (!(await isApprovedLinkedDevicePeer(peerConvId, "contact_event", context))) return false;
  const profile = body.profile;

  if (!profile || !profile.friendId) return false;
  const profiles = await listProfiles(context?.vault);
  const matches = profiles.filter(item => body.v === 2 ? item.kind === "friend" && item.identityPub === profile.identityPub : item.friendId === profile.friendId);

  if (matches.length > 1) return false;
  const existing = matches[0] ?? null;

  if (existing?.identityPub && existing.dhPub && profile.identityPub && profile.dhPub) {
    const tofu = applyTOFU(
      { identityPub: existing.identityPub, dhPub: existing.dhPub },
      { identityPub: profile.identityPub, dhPub: profile.dhPub }
    );

    if (!tofu.ok) {
      const blocked: UserProfile = {
        ...existing,
        trust: {
          pinnedAt: existing.trust?.pinnedAt ?? Date.now(),
          status: "blocked",
          reason: tofu.reason,
        },
        friendStatus: "blocked",
        updatedAt: Date.now(),
      };

      if (context && application) return commitAuthenticatedProfile(blocked, existing, application, context.vault);
      await saveProfile(blocked, context?.vault);

      return true;
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
    friendStatus:
      existing?.friendStatus === "deleted"
        ? "deleted"
        : profile.friendStatus ?? existing?.friendStatus ?? "normal",
    isFavorite: profile.isFavorite ?? existing?.isFavorite ?? false,
    identityPub: profile.identityPub ?? existing?.identityPub,
    dhPub: profile.dhPub ?? existing?.dhPub,
    routingHints: sanitizedHints,
    primaryDeviceId:
      profile.primaryDeviceId ??
      (profile.routingHints)?.deviceId ??
      existing?.primaryDeviceId,
    trust: existing?.trust ?? { pinnedAt: now, status: "trusted" },
    verification: existing?.verification,
    reachability: existing?.reachability,
    profileVcard: profile.profileVcard ?? existing?.profileVcard,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (context && application) return commitAuthenticatedProfile(next, existing, application, context.vault);
  await saveProfile(next, context?.vault);

  return true;
};

const applyConversationEvent = async (
  peerConvId: string,
  body: { type: "conv"; v?: 2; conv: Conversation; memberIdentities?: string[] }, context?: ReceiveContext,
  application?: { envelope: Envelope; eventHash: string }
) => {
  context?.vault.assertLocal();

  if (!(await isApprovedLinkedDevicePeer(peerConvId, "conversation_event", context))) return false;

  if (context && body.v === 2) {
    const binding = await resolveLinkedConversation(body, context);

    if (!binding || !application) return false;

    return commitAuthenticatedGroup(application.envelope, application.eventHash, binding.next, [], binding.previous,
      context.vault, binding.bindings);
  }

  const incoming = body.conv;

  if (!incoming?.id) return false;
  const existing = (await listConversations(context?.vault)).find((item) => item.id === incoming.id) || null;

  if (!existing) {
    console.warn("[sync] linked-device conversation ignored: no local binding", {
      peerConvId,
      incomingConvId: incoming.id,
    });

    return;
  }

  const merged: Conversation = {
    ...existing,
    name: incoming.name ?? existing.name,
    lastTs: incoming.lastTs ?? existing.lastTs,
    lastMessage: incoming.lastMessage ?? existing.lastMessage,
    sharedAvatarRef: incoming.sharedAvatarRef ?? existing.sharedAvatarRef,
    // Participant/profile IDs are local database identifiers. Never import a
    // linked device's opaque IDs into this database.
    participants: existing.participants,
  };

  if (context && application) return commitAuthenticatedGroup(application.envelope, application.eventHash, merged, [], existing, context.vault, []);
  await saveConversation(merged, context?.vault);

  return true;
};

/** Only current approved own endpoints carry v2 account metadata; local UI/cache fields never enter its wire body. */
const validateLinkedMetadata = async (body: unknown, context: ReceiveContext) => {
  const value = body as { type?: string; v?: number; profile?: Partial<UserProfile> };

  if (!body || typeof body !== "object" || value.v !== 2 || !await getAccountRootIdentity(context)) return false;

  if (value.type === "conv") return Boolean(await resolveLinkedConversation(body, context));
  const profile = value.profile;

  if (value.type !== "contact" || !profile || typeof profile.identityPub !== "string" || typeof profile.dhPub !== "string" ||
    profile.identityPub === await getAccountRootIdentity(context) || "id" in profile || "isFavorite" in profile || "theme" in profile ||
    !["normal", "blocked", "deleted"].includes(profile.friendStatus ?? "") || typeof profile.displayName !== "string" ||
    profile.displayName.length > 256 || typeof profile.status !== "string" || profile.status.length > 4096) return false;

  try {
    const identity = decodeBase64Url(profile.identityPub), dh = decodeBase64Url(profile.dhPub);

    return identity.length === 32 && dh.length === 32 && encodeBase64Url(identity) === profile.identityPub &&
      encodeBase64Url(dh) === profile.dhPub && computeFriendId(identity) === profile.friendId;
  } catch { return false; }
};

const resolveLinkedConversation = async (body: unknown, context: ReceiveContext) => {
  const value = body as { type?: string; v?: number; conv?: { id?: string; type?: string; name?: string }; memberIdentities?: string[] };
  const root = await getAccountRootIdentity(context);

  if (!root || value?.type !== "conv" || value.v !== 2 || !value.conv || typeof value.conv.id !== "string" ||
    !value.conv.id || value.conv.id.length > 128 || !["direct", "group"].includes(value.conv.type ?? "") ||
    typeof value.conv.name !== "string" || value.conv.name.length > 256 || !Array.isArray(value.memberIdentities) ||
    value.memberIdentities.length < 2 || value.memberIdentities.length > 256 ||
    new Set(value.memberIdentities).size !== value.memberIdentities.length || !value.memberIdentities.includes(root) ||
    Object.keys(value.conv).some(key => !["id", "type", "name"].includes(key))) return null;
  const profiles = await listProfiles(context.vault), users = profiles.filter(item => item.kind === "user");

  if (users.length !== 1) return null;
  const bindings: Array<{ id: string; identityPub: string }> = [];

  for (const identityPub of value.memberIdentities) {
    const matches = identityPub === root ? users : profiles.filter(item => item.kind === "friend" && item.identityPub === identityPub &&
      item.friendStatus === "normal" && item.trust?.status === "trusted" && item.verification?.status !== "key_changed");

    if (matches.length !== 1) return null;
    bindings.push({ id: matches[0].id, identityPub });
  }

  const conversations = await listConversations(context.vault);
  const ids = bindings.map(item => item.id);

  if (value.conv.type === "direct" && (ids.length !== 2 || value.conv.id !== await logicalConversationIdentity(...value.memberIdentities as [string, string]))) return null;

  const matches = conversations.filter(item => value.conv!.type === "group" ? item.id === value.conv!.id :
    item.type !== "group" && item.participants.length === 2 && ids.every(id => item.participants.includes(id)));

  if (matches.length > 1 || matches[0] && (matches[0].type === "group" && value.conv.type !== "group" ||
    value.conv.type === "group" && matches[0].type !== "group")) return null;
  const previous = matches[0] ?? null;

  const next: Conversation = { ...(previous ?? { id: value.conv.type === "group" ? value.conv.id : createId(),
    pinned: false, unread: 0, hidden: false, muted: false, blocked: false, lastTs: 0, lastMessage: "" }),
    // Linked snapshots initialize groups; later membership changes require authenticated GROUP events.
    type: value.conv.type as "direct" | "group", name: value.conv.name, participants: previous?.type === "group" ? previous.participants : ids };

  return { next, previous, bindings };
};

const isEphemeralMediaChunk = (body: unknown) => {
  if (!body || typeof body !== "object") return false;

  return "type" in body && body.type === "media" && "phase" in body && body.phase === "chunk";
};

const persistAppliedEnvelope = async (envelope: Envelope, body: unknown, context?: ReceiveContext) => {
  context?.vault.assertLocal();

  if (isEphemeralMediaChunk(body)) return;
  const eventHash = await computeEnvelopeHash(envelope);
  const expectedPrev = await getLastEventHash(envelope.header.convId, context?.vault);
  const mismatch = envelope.header.prev !== expectedPrev;

  if (mismatch) console.warn("[sync] event chain mismatch");
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
    bodyType: body && typeof body === "object" && "type" in body && body.type === "msg" ? "msg" : undefined,
    applicationState: body && typeof body === "object" && "type" in body && body.type === "msg" ? "pending" : undefined,
  }, context?.vault);
};

const validateDeliveredReceipt = async (peerConvId: string, envelope: IncomingEnvelope, body: unknown, context: ReceiveContext) => {
  if (!body || typeof body !== "object") return false;
  const receipt = body;

  if (!("type" in receipt) || receipt.type !== "rcpt" || !("kind" in receipt) || receipt.kind !== "delivered" || envelope.header.rk?.v !== 2 ||
    !("msgId" in receipt) || typeof receipt.msgId !== "string" || !("convId" in receipt) || receipt.convId !== peerConvId ||
    !("eventHash" in receipt) || typeof receipt.eventHash !== "string") return false;
  const logical = await logicalReceiptBinding(peerConvId, body, context);

  if (envelope.header.deviceDelivery) return Boolean(logical &&
    await applyAuthenticatedDeliveredReceipt(logical, context.vault, false));
  const conv = (await listConversations(context.vault)).find(item => item.id === peerConvId) ?? null;
  const pinnedIdentity = peerContexts.get(ownerKey(peerConvId, context))?.identityPub;

  const sender = (await listProfiles(context.vault)).find(profile => profile.kind === "friend" &&
    profile.identityPub === pinnedIdentity && conv?.participants.includes(profile.id));

  if (!sender?.identityPub) return false;

  return applyAuthenticatedDeliveredReceipt({ messageId: receipt.msgId, convId: peerConvId,
    peerIdentityPub: sender.identityPub, eventHash: receipt.eventHash }, context.vault, false);
};

const requireLegacyApplicationEnvelope = (envelope: IncomingEnvelope) => {
  if (!isEnvelopeLike(envelope)) throw new Error("UNSUPPORTED_BINARY_APPLICATION");

  return envelope;
};

const logicalReceiptBinding = async (channelId: string, body: unknown, context: ReceiveContext) => {
  const receipt = body as { msgId?: string; logicalMessageId?: string; eventHash?: string; logicalDelivered?: LogicalDelivered };
  const peer = peerContexts.get(ownerKey(channelId, context));

  if (peer?.deviceAuthorizationVersion !== 2 || !receipt.msgId || !receipt.logicalMessageId || !receipt.eventHash ||
    !peer.identityPub || !peer.accountRootIdentity || !peer.peerDeviceId) return null;
  const approved = await getAuthorizedDevice(peer.peerDeviceId, context, peer.accountRootIdentity);
  const message = await getStoredMessage(receipt.logicalMessageId, context.vault);
  const outgoing = await getEvent(receipt.msgId, context.vault);

  if (!approved || approved.identityPub !== peer.identityPub || !message?.logicalProof ||
    (message.logicalProof.groupId ? !(await resolveAccountGroup(message.logicalProof.groupId, context))?.members.has(peer.accountRootIdentity) :
      message.logicalProof.recipientAccountIdentity !== peer.accountRootIdentity) ||
    (JSON.parse(outgoing?.envelopeJson ?? "null") as Envelope | null)?.header.deviceDelivery?.deliveryId !==
    await deviceDeliveryIdentity(message.id, approved, getOrCreateDeviceId(context)) ||
    outgoing?.eventHash !== receipt.eventHash || outgoing.convId !== channelId) return null;
  const proof = receipt.logicalDelivered;

  if (!proof || !await verifyLogicalDelivered(proof, context) || proof.logicalMessageId !== message.id ||
    proof.conversationIdentity !== message.logicalProof.conversationIdentity ||
    proof.senderAccountIdentity !== message.logicalProof.senderAccountIdentity ||
    proof.recipientAccountIdentity !== peer.accountRootIdentity || proof.groupId !== message.logicalProof.groupId ||
    proof.author.deviceId !== approved.deviceId || proof.author.identityPub !== approved.identityPub ||
    proof.targetEventId !== receipt.msgId || proof.targetEventHash !== receipt.eventHash ||
    proof.targetAuthorDeviceId !== getOrCreateDeviceId(context)) return null;

  return { messageId: receipt.msgId, convId: channelId, peerIdentityPub: peer.identityPub, eventHash: receipt.eventHash,
    logicalMessageId: message.id, logicalConvId: message.convId, recipientAccountIdentity: peer.accountRootIdentity,
    logicalDelivered: proof };
};

const resolveLogicalConversation = async (proof: LogicalMessage, context: ReceiveContext) => {
  if (proof.groupId !== undefined) {
    const group = await resolveAccountGroup(proof.groupId, context);
    const senderId = group?.members.get(proof.senderAccountIdentity);

    return group && senderId ? { conv: group.conv, senderId } : null;
  }

  const ownRoot = await getAccountRootIdentity(context);
  const localUser = await resolveLocalUserId(context);

  if (!ownRoot || !localUser) return null;
  const otherRoot = proof.senderAccountIdentity === ownRoot ? proof.recipientAccountIdentity : proof.senderAccountIdentity;

  const friends = (await listProfiles(context.vault)).filter(profile => profile.kind === "friend" &&
    profile.identityPub === otherRoot && profile.friendStatus === "normal" && profile.trust?.status === "trusted" &&
    profile.verification?.status !== "key_changed");

  if (friends.length !== 1) return null;

  const conversations = (await listConversations(context.vault)).filter(conv => conv.type !== "group" &&
    conv.participants.length === 2 && conv.participants.includes(localUser) && conv.participants.includes(friends[0].id) && !conv.blocked);

  return conversations.length === 1 ? { conv: conversations[0], senderId: proof.senderAccountIdentity === ownRoot ? localUser : friends[0].id } : null;
};

const resolveLogicalRead = async (read: LogicalRead, context: ReceiveContext) => {
  if (!await verifyLogicalRead(read, context)) return null;
  const message = await getStoredMessage(read.anchorMsgId, context.vault);
  const proof = message?.logicalProof;

  if (!proof || (proof.groupId ? proof.groupId !== read.groupId : proof.recipientAccountIdentity !== read.readerAccountIdentity) ||
    proof.senderAccountIdentity !== read.peerAccountIdentity || proof.conversationIdentity !== read.conversationIdentity ||
    proof.ts !== read.cursorTs) return null;
  const binding = await resolveLogicalConversation(proof, context);
  const localUserId = await resolveLocalUserId(context);
  const ownRead = read.readerAccountIdentity === await getAccountRootIdentity(context);
  const profiles = await listProfiles(context.vault);

  const actors = profiles.filter(profile => ownRead ? profile.kind === "user" && profile.id === localUserId :
    profile.kind === "friend" && profile.identityPub === read.readerAccountIdentity &&
    profile.friendStatus === "normal" && profile.trust?.status === "trusted" && profile.verification?.status !== "key_changed");

  const identityPub = ownRead ? encodeBase64Url(await getIdentityPublicKey(context)) : actors[0]?.identityPub;

  return binding && localUserId && actors.length === 1 && identityPub ?
    { convId: binding.conv.id, actorId: actors[0].id, cursorTs: read.cursorTs, anchorMsgId: read.anchorMsgId,
      logicalRead: read, application: { peerIdentityPub: identityPub, localUserId, ownRead } } : null;
};

/** Root pin and current registry authorize the endpoint; the outer signature still precedes secret access. */
const bindCertifiedEndpoint = async (channelId: string, author: DeviceAuthorization, captured: ReceiveContext) => {
  const context = await captureDeviceRegistryContext(captured);
  const ownId = getOrCreateDeviceId(context);

  if (!author || author.deviceId === ownId || channelId !== deviceChannelIdentity(ownId, author.deviceId)) {
    throw new Error("DEVICE_DELIVERY_BINDING_REJECTED");
  }

  const current = await getAuthorizedDevice(author.deviceId, context, author.accountRootIdentityPub);

  if (!current || author.kind !== "DEVICE_ADDED" || author.epoch > current.epoch ||
    author.identityPub !== current.identityPub || author.dhPub !== current.dhPub ||
    !await verifyDeviceAuthorization(author, author.accountRootIdentityPub)) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
  const key = ownerKey(channelId, context);
  const existing = peerContexts.get(key);

  const reuse = existing?.identityPub === current.identityPub && existing.dhPub === current.dhPub &&
    existing.accountRootIdentity === current.accountRootIdentityPub && existing.authenticatedCapsToken === context.owner.session.token;

  await context.vault.assertMain();
  setReceiveCache(context, peerContexts, key, {
    kind: current.accountRootIdentityPub === await getAccountRootIdentity(context) ? "device" : "friend",
    accountRootIdentity: current.accountRootIdentityPub, identityPub: current.identityPub, dhPub: current.dhPub,
    peerDeviceId: current.deviceId, friendKeyId: current.deviceId, deviceAuthorizationVersion: 2,
    onionAddr: current.route?.onionAddr, inboxWriteToken: current.route?.inboxWriteToken,
    ...(reuse ? { peerCaps: existing.peerCaps, authenticatedCapsToken: existing.authenticatedCapsToken } : {}),
  });

  return context;
};

const bindDeviceDelivery = async (envelope: IncomingEnvelope, context: ReceiveContext) => {
  const delivery = envelope.header.deviceDelivery;

  if (delivery?.v !== 2 || delivery.recipientDeviceId !== getOrCreateDeviceId(context) ||
    delivery.author?.deviceId !== envelope.header.authorDeviceId || envelope.header.rk?.v !== 2 ||
    !await verifyEnvelopeSignature(envelope, decodeBase64Url(delivery.author.identityPub))) {
    throw new Error("DEVICE_DELIVERY_BINDING_REJECTED");
  }

  return bindCertifiedEndpoint(envelope.header.convId, delivery.author, context);
};

/** Validate authenticated payloads before advancing the ordinary receive state. */
const validateOwnedBody = async (peerConvId: string, conv: Conversation | null, envelope: IncomingEnvelope,
  body: unknown, context: ReceiveContext) => {
  context.vault.assertLocal();

  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;

  if (isRawEnvelope(envelope) && (envelope.header.deviceDelivery || envelope.header.bodyCodec !== "canonical-json-v1" ||
      conv?.type === "group" || !conv || conv.participants.length !== 2 ||
      !(value.type === "msg" && typeof value.text === "string" && value.media === undefined ||
        value.type === "rcpt" && value.kind === "delivered"))) return false;

  if (value.type === "account_media") {
    const chunk = value.proof as LogicalMediaChunk;
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    if (value.v !== 2 || !chunk || typeof value.b64 !== "string" || !envelope.header.deviceDelivery || envelope.header.rk?.v !== 2 ||
      peer?.deviceAuthorizationVersion !== 2 || (peer.accountRootIdentity !== await getAccountRootIdentity(context) &&
        peer.accountRootIdentity !== chunk.senderAccountIdentity)) return false;
    const bytes = decodeBase64Url(value.b64);

    if (!await verifyLogicalMediaChunk(chunk, bytes, context)) return false;

    if (!await getStoredMessage(chunk.messageId, context.vault)) return true;
    const localUserId = await resolveLocalUserId(context);

    if (!localUserId) return false;

    try {
      await saveReceivedMessageMediaChunk({ ...chunk, ownerId: chunk.messageId, bytes }, context.vault,
        { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: "", authenticatedIdentity: chunk.senderAccountIdentity, localUserId, logicalProof: chunk, validateOnly: true });

      return true;
    } catch { return false; }
  }

  if (value.type === "account_profile") {
    const profile = body as AccountProfile;
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    if (!validAccountProfile(profile) || !envelope.header.deviceDelivery || envelope.header.rk?.v !== 2 ||
      peer?.deviceAuthorizationVersion !== 2 || peer.accountRootIdentity !== profile.accountRootIdentity) return false;
    const root = await getAccountRootIdentity(context);
    const profiles = await listProfiles(context.vault);

    return profiles.filter(item => profile.accountRootIdentity === root ? item.kind === "user" :
      item.kind === "friend" && item.identityPub === profile.accountRootIdentity && item.friendStatus === "normal" &&
      item.trust?.status === "trusted").length === 1;
  }

  if (value.type === "account_device") {
    const event = value.authorization as DeviceAuthorization;
    const peer = peerContexts.get(ownerKey(peerConvId, context));
    const root = await getAccountRootIdentity(context);

    if (value.v !== 2 || !event || !envelope.header.deviceDelivery || envelope.header.rk?.v !== 2 ||
      peer?.deviceAuthorizationVersion !== 2 || (peer.accountRootIdentity !== root && peer.accountRootIdentity !== event.accountRootIdentityPub) ||
      !await verifyDeviceAuthorization(event, event.accountRootIdentityPub)) return false;
    // The existing pinned account Root remains the authority, including when another own device relays its certificate.
    await getAuthorizedDeviceRegistry(context, event.accountRootIdentityPub);

    return true;
  }

  if (value.type === "account_read") {
    const read = body as LogicalRead;
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    if (!envelope.header.deviceDelivery || envelope.header.rk?.v !== 2 || peer?.deviceAuthorizationVersion !== 2 ||
      (peer.accountRootIdentity !== await getAccountRootIdentity(context) && peer.accountRootIdentity !== read.readerAccountIdentity)) return false;

    if (!await verifyLogicalRead(read, context)) return false;

    // An authenticated early cursor uses the existing retained candidate until its anchor arrives.
    // Rejecting it before crypto commit would lose its key when a later ordinary envelope advances the chain.
    if (!await getStoredMessage(read.anchorMsgId, context.vault)) return true;
    const binding = await resolveLogicalRead(read, context);

    if (!binding) return false;

    try { return await putReadCursor(binding, context.vault, { ...binding.application, validateOnly: true,
        eventId: envelope.header.eventId, eventHash: "", wireConvId: envelope.header.convId, lamport: envelope.header.lamport }); }
    catch { return false; }
  }

  if (value.type === "account_delivered") {
    const proof = body as LogicalDelivered;
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    if (!envelope.header.deviceDelivery || envelope.header.rk?.v !== 2 || peer?.deviceAuthorizationVersion !== 2 ||
      (peer.accountRootIdentity !== await getAccountRootIdentity(context) && peer.accountRootIdentity !== proof.recipientAccountIdentity) ||
      !await verifyLogicalDelivered(proof, context)) return false;

    if (!await getStoredMessage(proof.logicalMessageId, context.vault)) return true;

    try { return await putLogicalDelivered(proof, context, undefined, true); } catch { return false; }
  }

  if (value.type === "account_message") {
    const proof = body as LogicalMessage;
    const peer = peerContexts.get(ownerKey(peerConvId, context));
    const ownRoot = await getAccountRootIdentity(context);

    return Boolean(envelope.header.deviceDelivery?.v === 2 && peer?.deviceAuthorizationVersion === 2 &&
      envelope.header.rk?.v === 2 && await verifyLogicalMessage(proof, context) &&
      (peer.accountRootIdentity === ownRoot || peer.accountRootIdentity === proof.senderAccountIdentity) &&
      await resolveLogicalConversation(proof, context));
  }

  if (value.type === "msg") return Boolean(conv && value.logicalProof === undefined && typeof value.text === "string" &&
    (value.media === undefined || parseIncomingMediaRef(value.media, envelope.header.friendDeliveryId ?? envelope.header.eventId)));

  if (value.type === "rcpt" && value.kind === "media_stored") {
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    const accepted = envelope.header.rk?.v === 2 && value.convId === peerConvId && await canAutomaticallySendMediaStorageReceipt(peerConvId, context) && Boolean(peer?.identityPub &&
      await applyAuthenticatedMediaReceipt(body as MediaStoredReceipt, { peerIdentityPub: peer.identityPub,
        peerAccountIdentity: peer.accountRootIdentity ?? peer.identityPub, peerDeviceId: peer.peerDeviceId }, context.vault, false));

    if (!accepted) countSessionReason("MEDIA_RECEIPT_VALIDATION_REJECTED");

    return accepted;
  }

  if (value.type === "rcpt" && value.kind === "delivered") return validateDeliveredReceipt(peerConvId, envelope, body, context);

  if (value.type === "rcpt" && value.kind === "read_cursor") {
    const cursor = value.cursorTs ?? value.ts ?? envelope.header.ts;
    const anchor = value.anchorMsgId ?? value.msgId;

    if (!conv || value.convId !== peerConvId || !Number.isSafeInteger(cursor) || Number(cursor) < 0 ||
      Number(cursor) > Date.now() + HANDSHAKE_NONCE_TTL_MS ||
      (anchor !== undefined && (typeof anchor !== "string" || !anchor || anchor.length > 128))) return false;
    const localUserId = await resolveLocalUserId(context);
    const sender = await resolveSenderProfile(peerConvId, conv, localUserId, context);

    if (!sender?.identityPub || !localUserId) return false;

    try {
      return await putReadCursor({ convId: peerConvId, actorId: sender.id, cursorTs: Number(cursor), anchorMsgId: anchor },
        context.vault, { eventId: envelope.header.eventId, eventHash: "", lamport: envelope.header.lamport,
        wireConvId: envelope.header.convId, peerIdentityPub: sender.identityPub, localUserId, validateOnly: true });
    } catch { return false; }
  }

  if (isGroupEventPayload(body)) {
    const peer = peerContexts.get(ownerKey(peerConvId, context));
    const identity = peer?.deviceAuthorizationVersion === 2 ? peer.accountRootIdentity : peer?.identityPub;
    const mapped = identity ? await mapIncomingGroupEvent(body, identity, context) : null;

    if (!mapped) return false;
    const groupId = mapped.payload.kind === "group.create" ? mapped.payload.id : mapped.payload.groupId;
    const existing = (await listConversations(context.vault)).find(item => item.id === groupId);

    // Reject a current non-member before retaining an authenticated application or advancing crypto.
    return !existing || existing.type === "group" && !existing.hidden &&
      existing.participants.includes(mapped.payload.actorId) && existing.participants.includes(await resolveLocalUserId(context) ?? "");
  }

  if (value.type === "media" && value.phase === "chunk") {
    if (value.ownerType === "group" && (value.v !== 2 || value.identityKind !== "ed25519" ||
      value.actorIdentity !== peerContexts.get(ownerKey(peerConvId, context))?.identityPub || typeof value.revision !== "string")) return false;
    const media = parseIncomingMediaRef({ ...value, ownerType: "message" });

    if (!media || typeof value.b64 !== "string" || !Number.isSafeInteger(value.idx) ||
      Number(value.idx) < 0 || Number(value.idx) >= media.total) return false;

    try {
      const bytes = decodeBase64Url(value.b64);

      if (bytes.length !== Math.min(media.chunkSize, media.size - Number(value.idx) * media.chunkSize)) return false;
      const identity = peerContexts.get(ownerKey(peerConvId, context))?.identityPub;
      const localUserId = await resolveLocalUserId(context);

      if (!identity || !localUserId) return false;
      await saveReceivedMessageMediaChunk({ ...media, idx: Number(value.idx), bytes,
        ownerType: value.ownerType === "group" ? "group" : "message", revision: value.revision as string | undefined }, context.vault,
        { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: "", authenticatedIdentity: identity, localUserId, validateOnly: true });

      return true;
    } catch (error) {
      // A valid chunk may precede its manifest; the existing authenticated candidate owns recovery.
      return error instanceof Error && error.message === "Media manifest is missing";
    }
  }

  if (isFriendControlFrame(body)) {
    const peer = peerContexts.get(ownerKey(peerConvId, context));

    return body.from.identityPub === peer?.identityPub && body.from.dhPub === peer?.dhPub &&
      (body.from.deviceId === undefined || body.from.deviceId === envelope.header.authorDeviceId) &&
      (body.convId === undefined || body.convId === peerConvId) && isFriendControlFrameFresh(body) &&
      (await verifyFriendControlFrameProtocol(body)).ok;
  }

  if (value.type === "contact") {
    if (envelope.header.deviceDelivery && value.v !== 2) return false;

    if (value.v === 2) return Boolean(await isApprovedLinkedDevicePeer(peerConvId, "contact_event", context) &&
      await validateLinkedMetadata(body, context));
    const profile = value.profile as Partial<UserProfile> | undefined;

    if (!await isApprovedLinkedDevicePeer(peerConvId, "contact_event", context) || !profile || typeof profile !== "object" ||
      typeof profile.friendId !== "string" || typeof profile.identityPub !== "string" || typeof profile.dhPub !== "string") return false;

    try {
      const identity = decodeBase64Url(profile.identityPub), dh = decodeBase64Url(profile.dhPub);

      return identity.length === 32 && dh.length === 32 && encodeBase64Url(identity) === profile.identityPub &&
        encodeBase64Url(dh) === profile.dhPub && computeFriendId(identity) === profile.friendId;
    } catch { return false; }
  }

  if (value.type === "conv" && value.v === 2) return Boolean(await isApprovedLinkedDevicePeer(peerConvId, "conversation_event", context) &&
    await resolveLinkedConversation(body, context));

  if (value.type === "conv" && envelope.header.deviceDelivery) return false;

  if (value.type === "conv") return Boolean(await isApprovedLinkedDevicePeer(peerConvId, "conversation_event", context) &&
    value.conv && typeof value.conv === "object" && (await listConversations(context.vault)).some(item =>
      item.id === (value.conv as Conversation).id && ((value.conv as Conversation).sharedAvatarRef === undefined ||
        (value.conv as Conversation).sharedAvatarRef === item.sharedAvatarRef)));

  if (value.kind === "ROLE_CHANGE") return typeof value.deviceId === "string" && value.deviceId === envelope.header.authorDeviceId &&
    value.deviceId === peerContexts.get(ownerKey(peerConvId, context))?.peerDeviceId &&
    await isApprovedLinkedDevicePeer(peerConvId, "role_event", context) &&
    (value.role === "primary" || value.role === "secondary") && Number.isSafeInteger(value.epoch) &&
    Number(value.epoch) >= 0 && Number.isFinite(value.ts) && (value.reason === "user" || value.reason === "handover");

  return false;
};

const commitAppliedEnvelope = async (
  convKeyId: string, conv: Conversation | null, envelope: IncomingEnvelope, body: unknown,
  diagnosticContext?: DeliveryContext, commitRatchet?: () => Promise<void>, context?: ReceiveContext, ratchetCommitFingerprint?: string
) => {
  context?.vault.assertLocal();
  const isLogicalText = Boolean(body && typeof body === "object" && "type" in body && body.type === "account_message");
  const isText = isLogicalText || body && typeof body === "object" && "type" in body && body.type === "msg";
  const receivingAccount = context?.owner.accountId ?? getActiveAccountId();

  try {
    if (context) {
      if (isRawEnvelope(envelope) && commitRatchet && !ratchetCommitFingerprint) throw new Error("RECEIVE_COMMIT_INCOMPLETE");


      if (!await validateOwnedBody(convKeyId, conv, envelope, body, context)) throw new Error("INVALID_APPLICATION_BODY");
      const eventHash = await computeEnvelopeHash(envelope);
      const type = body && typeof body === "object" && "type" in body ? body.type : undefined;
      const mediaBinding = await mediaChunkBinding(body);
      await retainAuthenticatedApplication({ eventId: envelope.header.eventId, convId: envelope.header.convId,
        authorDeviceId: envelope.header.authorDeviceId, lamport: envelope.header.lamport, ts: envelope.header.ts,
        ...(isRawEnvelope(envelope) ? { envelopeFormat: "nkce-v1" as const, envelopeBytes: encodeBinaryEnvelopeFrame(envelope) }
          : { envelopeJson: JSON.stringify(envelope) }), prevHash: envelope.header.prev, eventHash, ratchetCommitFingerprint,
        bodyType: type === "msg" || isLogicalText ? "msg" : type === "rcpt" ? "rcpt" : "control",
        localConvId: isLogicalText ? (await resolveLogicalConversation(body as LogicalMessage, context))!.conv.id : convKeyId,
        ...(envelope.header.deviceDelivery && type !== "account_media" && !isEphemeralMediaChunk(body)
          ? { applicationBodyHash: await historyBodyHash(body) } : {}),
        ephemeralApplication: isEphemeralMediaChunk(body) || Boolean(mediaBinding), ratchetVersion: envelope.header.rk?.v,
        ...(mediaBinding ? { mediaReceipt_enc: await encryptJsonRecord(context.vault.key, envelope.header.eventId, "media-receipt", mediaBinding) } : {}) }, body, context.vault);

      freshReceiveStages.set(ownerKey(convKeyId, context), "retained");

      if (commitRatchet) await commitRatchet();
      freshReceiveStages.set(ownerKey(convKeyId, context), "ratchet");
      await writeVault(context.vault, [context.vault.db.events], async () => {
        const updated = await context.vault.db.events.update(envelope.header.eventId, { applicationCryptoCommitted: true,
          ...(isLogicalText ? { logicalMessageId: (body as LogicalMessage).id } : {}) });


        if (updated !== 1) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
      });


      if (ratchetCommitFingerprint && envelope.header.rk) {
        const sid = envelope.header.deviceDelivery?.sessionId ?? envelope.header.friendSessionId;
        await acknowledgeReceiveCommit(sid ? freshRatchetChannel(envelope.header.convId, sid) : envelope.header.convId,
          envelope.header.rk.v, ratchetCommitFingerprint, getSecretStore(context.owner.session));
      }
    } else {
      if (isRawEnvelope(envelope)) throw new Error("OWNER_REQUIRED");


      if (commitRatchet) await commitRatchet();
      await persistAppliedEnvelope(envelope, body, context);
    }

    if (isText && !isLogicalText && !conv) throw new Error("RECEIVE_CONTEXT_UNAVAILABLE");

    const apply = async () => {
      const applied = await applyDecryptedBody(convKeyId, conv, requireLegacyApplicationEnvelope(envelope), body, diagnosticContext, context);

      if (context && !applied) throw new Error("APPLICATION_EFFECT_INCOMPLETE");

      if (isText) {
        await markTextEventStored(envelope.header.eventId, context?.vault);

        if (context) {
          const record = await getEvent(envelope.header.eventId, context.vault);
          const message = await getStoredMessage(envelope.header.friendDeliveryId ?? envelope.header.eventId, context.vault);

          if (record?.applicationState !== "stored" || message?.convId !== convKeyId) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
        }
      }

      if (context) await context.vault.db.events.update(envelope.header.eventId,
        { applicationState: "stored", authenticatedBody_enc: undefined });
    };

    if (context) freshReceiveStages.set(ownerKey(convKeyId, context), "application");

    if (context && isLogicalText) {
      const proof = body as LogicalMessage;
      const binding = await resolveLogicalConversation(proof, context);

      if (!binding) throw new Error("LOGICAL_CONVERSATION_UNAVAILABLE");
      await commitAuthenticatedText(envelope, { text: proof.text, media: proof.media, logicalProof: proof },
        binding.conv.id, binding.senderId, false, await computeEnvelopeHash(envelope), context.vault);
    }
    else if (context && isText) {
      const currentUserId = await resolveLocalUserId(context);
      const sender = await resolveSenderProfile(convKeyId, conv, currentUserId, context);

      if (sender) await repairDirectConversationPeerBinding(convKeyId, sender, currentUserId, context);
      const text = body as { text: string; media?: unknown; clientBatchId?: string };

      if (text.media === undefined) {
        firstMessageMeasurement.stage(envelope.header.eventId, "decrypted", diagnosticContext);
        firstMessageMeasurement.messageAuthenticated(envelope.header.eventId);
      }

      await commitAuthenticatedText(envelope, { ...text, media: text.media === undefined ? undefined :
          parseIncomingMediaRef(text.media, envelope.header.friendDeliveryId ?? envelope.header.eventId) ?? undefined }, convKeyId,
        sender?.id ?? currentUserId ?? envelope.header.authorDeviceId, sender?.friendStatus === "deleted",
        await computeEnvelopeHash(envelope), context.vault);
      const record = await getEvent(envelope.header.eventId, context.vault);
      const message = await getStoredMessage(envelope.header.friendDeliveryId ?? envelope.header.eventId, context.vault);

      if (record?.applicationState !== "stored" || message?.convId !== convKeyId) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "account_media") {
      const chunk = body as { type: "account_media"; proof: LogicalMediaChunk; b64: string };
      const localUserId = await resolveLocalUserId(context);

      if (!localUserId) throw new Error("MEDIA_OWNER_MISMATCH");
      await saveReceivedMessageMediaChunk({ ...chunk.proof, ownerId: chunk.proof.messageId, bytes: decodeBase64Url(chunk.b64) }, context.vault,
        { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: await computeEnvelopeHash(envelope), authenticatedIdentity: chunk.proof.senderAccountIdentity,
          localUserId, logicalProof: chunk.proof });
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "account_device") {
      const event = (body as { type: "account_device"; authorization: DeviceAuthorization }).authorization;
      await commitDeviceAuthorization(event, event.accountRootIdentityPub, context, false, {
        eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope),
        wireConvId: envelope.header.convId, lamport: envelope.header.lamport });
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "account_read") {
      const binding = await resolveLogicalRead(body as LogicalRead, context);

      if (!binding) throw new Error("READ_ACTOR_MISMATCH");
      await putReadCursor(binding, context.vault, { ...binding.application, eventId: envelope.header.eventId,
        eventHash: await computeEnvelopeHash(envelope), wireConvId: envelope.header.convId, lamport: envelope.header.lamport });
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "account_delivered") {
      await putLogicalDelivered(body as LogicalDelivered, context, { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: await computeEnvelopeHash(envelope) });
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "rcpt" &&
      "kind" in body && body.kind === "media_stored") {
      const peer = peerContexts.get(ownerKey(convKeyId, context));

      if (!peer?.identityPub || !await applyAuthenticatedMediaReceipt(body as MediaStoredReceipt,
        { peerIdentityPub: peer.identityPub, peerAccountIdentity: peer.accountRootIdentity ?? peer.identityPub, peerDeviceId: peer.peerDeviceId },
        context.vault, true, { eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope),
        wireConvId: envelope.header.convId, lamport: envelope.header.lamport })) {
        countSessionReason("MEDIA_RECEIPT_COMMIT_REJECTED");
        throw new Error("INVALID_MEDIA_STORAGE_RECEIPT");
      }
    }
    else if (context && body && typeof body === "object" &&
      (body as { type?: unknown; kind?: unknown }).type === "rcpt" && ("kind" in body ? body.kind : undefined) === "delivered") {
      const receipt = body as { msgId: string; eventHash: string };
      const identityPub = peerContexts.get(ownerKey(convKeyId, context))?.identityPub;

      const binding = envelope.header.deviceDelivery ? await logicalReceiptBinding(convKeyId, body, context) :
        identityPub ? { messageId: receipt.msgId, convId: convKeyId, eventHash: receipt.eventHash, peerIdentityPub: identityPub } : null;

      if (!binding || !await applyAuthenticatedDeliveredReceipt(binding, context.vault, true, {
        eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope),
        wireConvId: envelope.header.convId, lamport: envelope.header.lamport,
      })) throw new Error("INVALID_APPLICATION_DELIVERY_RECEIPT");
    }
    else if (context && isGroupEventPayload(body)) {
      const peer = peerContexts.get(ownerKey(convKeyId, context));
      const identity = peer?.deviceAuthorizationVersion === 2 ? peer.accountRootIdentity : peer?.identityPub;
      const mapped = identity ? await mapIncomingGroupEvent(body, identity, context) : null;
      const currentUserId = await resolveLocalUserId(context);

      if (!mapped || !identity || !await applyGroupEvent(mapped.payload, mapped.payload.actorId, currentUserId, context, {
        envelope: requireLegacyApplicationEnvelope(envelope), eventHash: await computeEnvelopeHash(envelope), actorIdentity: identity,
        bindings: mapped.bindings,
      })) throw new Error("GROUP_APPLICATION_REJECTED");
    }
    else if (context && isEphemeralMediaChunk(body)) {
      const chunk = body as { ownerId: string; idx: number; total: number; chunkSize: number; size: number; mime: string;
        b64: string; ownerType?: "message" | "group"; revision?: string };

      const identity = peerContexts.get(ownerKey(convKeyId, context))?.identityPub;
      const localUserId = await resolveLocalUserId(context);

      if (!identity || !localUserId) throw new Error("MEDIA_OWNER_REQUIRED");
      await saveReceivedMessageMediaChunk({ ...chunk, bytes: decodeBase64Url(chunk.b64) }, context.vault,
        { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: await computeEnvelopeHash(envelope), authenticatedIdentity: identity, localUserId });
    }
    else if (context && body && typeof body === "object" && ("kind" in body ? body.kind : undefined) === "ROLE_CHANGE") {
      if (!canUseRoleEvents(getPeerCaps(convKeyId, context))) throw new Error("PEER_ROLE_CAPABILITY_PENDING");
      await commitAuthenticatedRoleEvent(body as RoleChangeEvent, requireLegacyApplicationEnvelope(envelope), await computeEnvelopeHash(envelope), context);
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "rcpt" &&
      ("kind" in body ? body.kind : undefined) === "read_cursor") {
      const receipt = body as { type: "rcpt"; convId: string; cursorTs?: number; ts?: number; anchorMsgId?: string; msgId?: string };
      const localUserId = await resolveLocalUserId(context);
      const sender = await resolveSenderProfile(convKeyId, conv, localUserId, context);

      if (!sender?.identityPub || !localUserId) throw new Error("READ_CURSOR_ACTOR_MISMATCH");
      await putReadCursor({ convId: receipt.convId, actorId: sender.id,
        cursorTs: receipt.cursorTs ?? receipt.ts ?? envelope.header.ts, anchorMsgId: receipt.anchorMsgId ?? receipt.msgId }, context.vault,
        { eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope), lamport: envelope.header.lamport,
          wireConvId: envelope.header.convId, peerIdentityPub: sender.identityPub, localUserId });
      firstMessageMeasurement.authenticatedRead(convKeyId, receipt.anchorMsgId ?? receipt.msgId);
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "contact") {
      if (!await applyContactEvent(convKeyId, body as { type: "contact"; profile: Partial<UserProfile> }, context,
        { eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope), convId: envelope.header.convId,
          lamport: envelope.header.lamport, candidate: true })) throw new Error("CONTACT_APPLICATION_REJECTED");
    }
    else if (context && body && typeof body === "object" && "type" in body && body.type === "conv") {
      if (!await applyConversationEvent(convKeyId, body as { type: "conv"; conv: Conversation }, context,
        { envelope: requireLegacyApplicationEnvelope(envelope), eventHash: await computeEnvelopeHash(envelope) })) throw new Error("CONVERSATION_APPLICATION_REJECTED");
    }
    else if (context && (body as { type?: string })?.type === "account_profile") {
      const profile = body as AccountProfile;
      const own = profile.accountRootIdentity === await getAccountRootIdentity(context);

      const target = (await listProfiles(context.vault)).find(item => own ? item.kind === "user" :
        item.kind === "friend" && item.identityPub === profile.accountRootIdentity);

      if (!await applyProfileUpdate({ type: "profile_update", from: { identityPub: profile.accountRootIdentity,
          dhPub: peerContexts.get(ownerKey(convKeyId, context))!.dhPub! }, profile: profile.profile, ts: profile.ts }, target ?? null,
        context, { eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope),
        convId: envelope.header.convId, lamport: envelope.header.lamport, candidate: true }, own, true)) throw new Error("PROFILE_APPLICATION_REJECTED");
    }
    else if (context && isFriendControlFrame(body)) {
      if (!await handleIncomingFriendFrame(body, { trustedEnvelope: true,
        application: { eventId: envelope.header.eventId, eventHash: await computeEnvelopeHash(envelope),
          convId: envelope.header.convId, lamport: envelope.header.lamport, candidate: true } }, context)) throw new Error("PROFILE_APPLICATION_REJECTED");
    }
    else if (context) throw new Error("UNSUPPORTED_OWNED_APPLICATION");
    else await apply();

    if (isText && (body as { media?: unknown }).media === undefined) {
      firstMessageMeasurement.stage(envelope.header.eventId, "stored", diagnosticContext);
      firstMessageMeasurement.messageStored(envelope.header.eventId);

      if (diagnosticContext?.deliveryPath === "sync_response") notifyAuthenticatedSyncTextStored(receivingAccount);
    }

    updateLamportSeen(envelope.header.convId, envelope.header.authorDeviceId, envelope.header.lamport, context);

    if (context) freshReceiveStages.set(ownerKey(convKeyId, context), "stored");

    return isText ? { status: "STORED", accountId: receivingAccount, eventId: envelope.header.eventId } as const
      : context ? { status: "CONTROL_APPLIED", accountId: receivingAccount, operationId: context.owner.operationId } as const
        : { status: "FAILED", code: "NON_TEXT_DURABLE_COMPLETION_UNVERIFIED" } as const;
  } catch (error) {
    if (context) {
      try {
        await context.vault.assertMain();
        const pending = await getEvent(envelope.header.eventId, context.vault);

        if (pending?.authenticatedBody_enc &&
          pending.eventHash === await computeEnvelopeHash(envelope)) {
          console.warn("[sync] owned application deferred", error instanceof Error ? error.message.match(/^[A-Z_]+$/)?.[0] ?? "UNCLASSIFIED" : "UNCLASSIFIED");

          return {
            status: "OWNED_DEFERRED", accountId: receivingAccount, eventId: pending.eventId,
            recoveryOwner: { mechanism: "existing-event", reference: pending.eventId },
          } as const;
        }
      } catch { /* Revoked operation cannot certify recovery custody. */ }
    }

    if (isText) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
    throw error;
  }
};

const ensurePeerContextFromConversation = async (convId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const existing = peerContexts.get(ownerKey(convId, context));

  if (existing?.identityPub && existing?.dhPub) return true;

  const [conversations, profiles, localUserId] = await Promise.all([
    listConversations(context?.vault),
    listProfiles(context?.vault),
    resolveLocalUserId(context),
  ]);

  if (!localUserId) return false;

  const conv = conversations.find((item) => item.id === convId) ?? null;

  if (!conv) return false;

  const isDirect =
    !(conv.type === "group" || conv.participants.length > 2) &&
    conv.participants.length === 2;

  if (!isDirect) return false;

  const partnerId = conv.participants.find((id) => id && id !== localUserId) ?? null;

  if (!partnerId) return false;

  const partner =
    profiles.find((profile) => profile.id === partnerId && profile.kind === "friend") ?? null;

  if (!partner?.identityPub || !partner.dhPub) return false;

  setReceiveCache(context, peerContexts, ownerKey(conv.id, context), {
    ...existing,
    kind: "friend",
    friendKeyId: existing?.friendKeyId ?? partner.friendId ?? partner.id,
    identityPub: existing?.identityPub ?? partner.identityPub,
    dhPub: existing?.dhPub ?? partner.dhPub,
    onionAddr: existing?.onionAddr ?? partner.routingHints?.onionAddr,
    peerDeviceId:
      existing?.peerDeviceId ??
      partner.routingHints?.deviceId ??
      partner.primaryDeviceId ??
      partner.deviceId,
  });

  return true;
};

const resolveFallbackConversationId = async (envelope: IncomingEnvelope, context?: ReceiveContext) => {
  context?.vault.assertLocal();

  const [conversations, profiles, localUserId] = await Promise.all([
    listConversations(context?.vault),
    listProfiles(context?.vault),
    resolveLocalUserId(context),
  ]);

  if (!localUserId) return null;

  const directCandidates = conversations.filter((conv) => {
    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) &&
      conv.participants.length === 2;

    return isDirect && conv.participants.includes(localUserId);
  });

  for (const conv of directCandidates) {
    const partnerId = conv.participants.find((id) => id && id !== localUserId) ?? null;

    if (!partnerId) continue;

    const partner =
      profiles.find((profile) => profile.id === partnerId && profile.kind === "friend") ?? null;

    if (!partner?.identityPub) continue;

    try {
      const verifyKey = decodeBase64Url(partner.identityPub);
      const verified = await verifyEnvelopeSignature(envelope, verifyKey);

      if (verified) {
        return conv.id;
      }
    } catch {
      // keep scanning candidates
    }
  }

  return null;
};

type IncomingReplyRoute = {
  toDeviceId: string;
  torOnion?: string;
  inboxWriteToken?: string;
  sentAt: number;
};

const refreshAuthenticatedFriendReplyRoute = async (
  frame: FriendControlFrame,
  replyRoute?: IncomingReplyRoute, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!frame.from.deviceId) return;
  const decoded = frame.from.friendCode ? decodeFriendCodeV1(frame.from.friendCode) : null;

  const signedRoute =
    decoded &&
      !("error" in decoded) &&
      decoded.identityPub === frame.from.identityPub &&
      decoded.dhPub === frame.from.dhPub &&
      decoded.deviceId === frame.from.deviceId
      ? decoded
      : null;

  const transportRoute =
    replyRoute &&
      replyRoute.toDeviceId === frame.from.deviceId &&
      Number.isFinite(replyRoute.sentAt)
      ? replyRoute
      : null;

  const friend = await resolveFriendByIdentity(frame.from.identityPub, context);

  if (!friend || friend.kind !== "friend") return;
  const current = sanitizeRoutingHints(friend.routingHints);
  const signed = sanitizeRoutingHints(signedRoute ?? undefined);

  const transport = transportRoute ? sanitizeRoutingHints({
    deviceId: transportRoute.toDeviceId,
    onionAddr: transportRoute.torOnion,
    inboxWriteToken: transportRoute.inboxWriteToken,
  }) : undefined;

  const onionAddr = signed?.onionAddr ?? current?.onionAddr ?? transport?.onionAddr;

  // A signed code authenticates only fields it actually contains. Keep an
  // established address pinned and never borrow a token from another address.
  if (!signed?.onionAddr && current?.onionAddr && transport?.onionAddr &&
    current.onionAddr !== transport.onionAddr) return;

  const routingHints = sanitizeRoutingHints({
    onionAddr,
    deviceId: signed?.deviceId ?? transport?.deviceId,
    inboxWriteToken: signed?.inboxWriteToken ??
      (transport?.onionAddr === onionAddr ? transport?.inboxWriteToken : undefined) ??
      (current?.onionAddr === onionAddr ? current?.inboxWriteToken : undefined),
  });

  if (!routingHints?.deviceId) return;

  const changed =
    routingHints.deviceId !== friend.routingHints?.deviceId ||
    routingHints.onionAddr !== friend.routingHints?.onionAddr ||
    routingHints.inboxWriteToken !== friend.routingHints?.inboxWriteToken;

  if (!changed) return;

  const now = Date.now();
  await saveProfile({
    ...friend,
    primaryDeviceId: routingHints.deviceId,
    routingHints,
    reachability: { status: "ok", lastAttemptAt: now },
    updatedAt: now,
  }, context?.vault, friend);

  if (frame.convId) {
    const peer = peerContexts.get(ownerKey(frame.convId, context));

    if (peer) {
      setReceiveCache(context, peerContexts, ownerKey(frame.convId, context), {
        ...peer,
        peerDeviceId: routingHints.deviceId,
        onionAddr: routingHints.onionAddr ?? peer.onionAddr,
      });
    }
  }

  emitFlowTraceLog({
    event: "friendControl:reply-route-refreshed",
    source: "sync:friendControl",
    convId: frame.convId,
    traceId: frame.traceId,
    routeSource: signed?.onionAddr ? "signed-friend-code" : "transport-reply-route",
  });
};

const refreshAuthenticatedReplyRoute = async (
  targetConvId: string,
  envelope: IncomingEnvelope,
  replyRoute?: IncomingReplyRoute, context?: ReceiveContext
) => {
  context?.vault.assertLocal();

  if (!replyRoute || replyRoute.toDeviceId !== envelope.header.authorDeviceId) return;

  if (!Number.isFinite(replyRoute.sentAt)) return;

  const hints = sanitizeRoutingHints({
    deviceId: replyRoute.toDeviceId,
    onionAddr: replyRoute.torOnion,
    inboxWriteToken: replyRoute.inboxWriteToken,
  });

  if (!hints?.deviceId) return;
  const verifyKey = await getPeerVerifyKey(targetConvId, envelope.header.authorDeviceId, context);

  if (!verifyKey || !(await verifyEnvelopeSignature(envelope, verifyKey))) return;

  const conv = (await listConversations(context?.vault)).find((item) => item.id === targetConvId) ?? null;
  const friend = await resolveSenderProfile(targetConvId, conv, await resolveLocalUserId(context), context);

  if (!friend) return;
  const currentOnion = friend.routingHints?.onionAddr;

  if (currentOnion && hints.onionAddr && currentOnion !== hints.onionAddr) return;

  const routingHints = sanitizeRoutingHints({
    onionAddr: currentOnion ?? hints.onionAddr,
    deviceId: hints.deviceId,
    inboxWriteToken: hints.inboxWriteToken ?? friend.routingHints?.inboxWriteToken,
  });

  if (!routingHints) return;

  const changed =
    routingHints.deviceId !== friend.routingHints?.deviceId ||
    routingHints.onionAddr !== friend.routingHints?.onionAddr ||
    routingHints.inboxWriteToken !== friend.routingHints?.inboxWriteToken;

  if (!changed) return;

  const now = Date.now();
  await saveProfile({
    ...friend,
    primaryDeviceId: routingHints.deviceId,
    routingHints,
    reachability: { status: "ok", lastAttemptAt: now },
    updatedAt: now,
  }, context?.vault, friend);
  const peer = peerContexts.get(ownerKey(targetConvId, context));

  if (peer) {
    setReceiveCache(context, peerContexts, ownerKey(targetConvId, context), {
      ...peer,
      peerDeviceId: routingHints.deviceId,
      onionAddr: routingHints.onionAddr ?? peer.onionAddr,
    });
  }

  emitFlowTraceLog({
    event: "incomingEnvelope:reply-route-refreshed",
    source: "sync:incomingEnvelope",
    convId: targetConvId,
    eventId: envelope.header.eventId,
  });
};

const replicateLogicalDelivered = async (proof: LogicalDelivered, context: ReceiveContext) => {
  if (!await verifyLogicalDelivered(proof, context)) throw new Error("DELIVERED_PROOF_INVALID");
  const message = await getStoredMessage(proof.logicalMessageId, context.vault);

  if (!message?.logicalProof) throw new Error("DELIVERED_TARGET_UNAVAILABLE");
  const binding = await resolveLogicalConversation(message.logicalProof, context);

  if (!binding) throw new Error("LOGICAL_CONVERSATION_UNAVAILABLE");
  const partner = (await listProfiles(context.vault)).find(item => item.kind === "friend" && binding.conv.participants.includes(item.id));

  if (!partner) throw new Error("OWNER_PEER_MISMATCH");
  const root = await getAccountRootIdentity(context);
  const targets = Object.values(await getAuthorizedDeviceRegistry(context));

  if (root === proof.recipientAccountIdentity && root !== proof.senderAccountIdentity)
    targets.push(...Object.values(await getAuthorizedDeviceRegistry(context, proof.senderAccountIdentity)));

  for (const target of targets) {
    if (target.kind !== "DEVICE_ADDED" || target.deviceId === getOrCreateDeviceId(context) ||
      target.deviceId === proof.targetAuthorDeviceId ||
      !await canAutomaticallySendDeliveredReceipt(deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId), context)) continue;
    await sendOwnedDirectEnvelope(binding.conv, partner, proof, "high", { context, deviceTarget: target,
      eventId: await deviceDeliveryIdentity(proof.id, target, getOrCreateDeviceId(context)),
      reuseEvent: true, v2Only: true, allowDeferred: true });
  }
};

const produceDeliveredReceipt = async (convId: string, envelope: IncomingEnvelope, context?: ReceiveContext) => {
  if (!context) return;
  const original = await getEvent(envelope.header.eventId, context.vault);

  if (original?.mediaReceipt_enc) {
    if (!await canAutomaticallySendMediaStorageReceipt(convId, context)) return;
    const receipt = await readStoredMediaReceipt(original, context.vault);

    if (!receipt || receipt.eventHash !== await computeEnvelopeHash(envelope)) return;
    const message = await getStoredMessage(receipt.ownerId, context.vault);
    const conv = (await listConversations(context.vault)).find(item => item.id === message?.convId && !item.hidden && !item.blocked);

    if (!conv) return;
    let queuedId: string;

    if (envelope.header.deviceDelivery) {
      const author = envelope.header.deviceDelivery.author;
      const target = await getAuthorizedDevice(author.deviceId, context, author.accountRootIdentityPub);
      const root = await getAccountRootIdentity(context);

      const partner = (await listProfiles(context.vault)).find(item => item.kind === "friend" &&
        (author.accountRootIdentityPub === root ? conv.participants.includes(item.id) : item.identityPub === author.accountRootIdentityPub));

      if (!target || !partner) return;

      const prepared = await sendOwnedDirectEnvelope(conv, partner, receipt, "high", { context, deviceTarget: target, v2Only: true,
        eventId: `media-stored:${original.eventId}`, reuseEvent: true, allowDeferred: true });

      queuedId = prepared.header.eventId;
    } else {
      const sender = await resolveSenderProfile(convId, conv, await resolveLocalUserId(context), context);

      if (!sender) return;

      const prepared = await sendOwnedDirectEnvelope(conv, sender, receipt, "high", { context, v2Only: true,
        eventId: `media-stored:${original.eventId}`, reuseEvent: true, allowDeferred: true });

      queuedId = prepared.header.eventId;
    }

    await writeVault(context.vault, [context.vault.db.events, context.vault.db.outbox], async () => {
      const queued = await context.vault.db.outbox.get(queuedId);

      if (queued?.ownerAccountId === context.owner.accountId &&
        (await context.vault.db.events.get(original.eventId))?.mediaReceipt_enc === original.mediaReceipt_enc) {
        await context.vault.db.events.update(original.eventId, { mediaReceiptQueued: true });
      }
    });

    return;
  }

  if (envelope.header.deviceDelivery) {
    if (original?.bodyType === "rcpt" && original.applicationState === "stored") {
      // Fresh sessions change wire IDs; the stored proof uses the stable delivery ID.
      const receipt = await context.vault.db.receipts.get(envelope.header.deviceDelivery.deliveryId ?? original.eventId);

      if (receipt?.logicalDelivered_enc) await replicateLogicalDelivered(
        await decryptJsonRecord<LogicalDelivered>(context.vault.key, receipt.id, "receipt", receipt.logicalDelivered_enc), context);

      return;
    }

    const message = original?.logicalMessageId ? await getStoredMessage(original.logicalMessageId, context.vault) : null;
    const root = await getAccountRootIdentity(context);

    if (original?.applicationState !== "stored" || !message?.logicalProof ||
        (!message.logicalProof.groupId && message.logicalProof.recipientAccountIdentity !== root) ||
        original.eventHash !== await computeEnvelopeHash(envelope)) return;
    const stored = await context.vault.db.receipts.get(`delivered:${original.eventId}`);

    const logicalDelivered = stored?.logicalDelivered_enc ?
      await decryptJsonRecord<LogicalDelivered>(context.vault.key, stored.id, "receipt", stored.logicalDelivered_enc) :
      await createLogicalDelivered(message.logicalProof, envelope, original.eventHash, context);

    await putLogicalDelivered(logicalDelivered, context);
    await replicateLogicalDelivered(logicalDelivered, context);

    if ((!message.logicalProof.groupId && envelope.header.deviceDelivery.author.accountRootIdentityPub === root) ||
        !await canAutomaticallySendDeliveredReceipt(convId, context)) return;

    const target = await getAuthorizedDevice(envelope.header.authorDeviceId, context, envelope.header.deviceDelivery.author.accountRootIdentityPub);
    const conv = (await listConversations(context.vault)).find(item => item.id === message.convId);
    const partner = (await listProfiles(context.vault)).find(item => item.kind === "friend" &&
      (message.logicalProof?.groupId && target?.accountRootIdentityPub === root ? conv?.participants.includes(item.id) :
        item.identityPub === target?.accountRootIdentityPub));

    if (!target || !conv || !partner) throw new Error("OWNER_PEER_MISMATCH");
    await sendOwnedDirectEnvelope(conv, partner, { type: "rcpt", kind: "delivered", convId,
      msgId: original.eventId, eventHash: original.eventHash, logicalMessageId: message.id, logicalDelivered }, "high", {
      context, deviceTarget: target, v2Only: true, eventId: `delivered:${original.eventId}`, reuseEvent: true, allowDeferred: true });

    return;
  }

  if (!await canAutomaticallySendDeliveredReceipt(convId, context)) return;

  if (original?.bodyType !== "msg" || original.applicationState !== "stored" ||
    original.eventHash !== await computeEnvelopeHash(envelope) ||
    !await getStoredMessage(envelope.header.friendDeliveryId ?? original.eventId, context.vault)) return;
  const conv = (await listConversations(context.vault)).find(item => item.id === convId) ?? null;
  const sender = await resolveSenderProfile(convId, conv, await resolveLocalUserId(context), context);

  if (!conv || !sender) throw new Error("OWNER_PEER_MISMATCH");
  await sendOwnedDirectEnvelope(conv, sender, { type: "rcpt", kind: "delivered", msgId: original.eventId,
    convId: envelope.header.convId, eventHash: original.eventHash }, "high", {
    context, v2Only: true, eventId: `delivered:${original.eventId}`, reuseEvent: true, allowDeferred: true,
  });
};

// A durable receive must release the mailbox before another channel can finish its handshake.
const scheduleDeliveredReceipt = (channel: string, envelope: IncomingEnvelope, context?: ReceiveContext) => {
  setTimeout(() => { void produceDeliveredReceipt(channel, envelope, context).catch(() => {
      // The stored original remains the authenticated receipt retry source at reconnect.
      console.warn("[sync] delivered receipt deferred");
    }); }, 0);
};

const supportsOrdinaryBinaryEnvelope = (envelope: IncomingEnvelope) => {
  const { rk, friendSessionId } = envelope.header;

  return envelope.header.bodyCodec === "canonical-json-v1" && rk?.v === 2 && Number.isSafeInteger(rk.i) && rk.i >= 0 &&
    typeof rk.dh === "string" && rk.dh.length > 0 && typeof friendSessionId === "string" && friendSessionId.length > 0 &&
    !envelope.header.deviceDelivery && !isUnifiedTextChannel(envelope.header.convId);
};

export const ingestIncomingEnvelopeText = async (
  payloadText: string | Uint8Array,
  options?: { replyRoute?: IncomingReplyRoute; diagnosticContext?: DeliveryContext }, context?: ReceiveContext
): Promise<IncomingCompletion | undefined> => {
  try {
    context?.vault.assertLocal();

    if (!context && typeof window !== "undefined" && window.nkc?.activateAccountSession) return { status: "FAILED", code: "OWNER_REQUIRED" };
    let parsed: unknown;
    let rawEnvelope: import("../crypto/box").EnvelopeBytes | undefined;

    try {
      if (payloadText instanceof Uint8Array) {
        if (payloadText.byteLength > ONION_TRANSFER_MAX_BODY_BYTES) return { status: "FAILED", code: "INVALID_BINARY_PACKET" };
        const packet = decodeBinaryTransportPacketV2(new Uint8Array(payloadText));

        if (!(packet.payload instanceof Uint8Array)) throw new Error("INVALID_BINARY_PACKET");
        rawEnvelope = decodeBinaryEnvelopeFrame(packet.payload);

        if (packet.id !== rawEnvelope.header.eventId || !context || !supportsOrdinaryBinaryEnvelope(rawEnvelope)) {
          return { status: "FAILED", code: "UNSUPPORTED_BINARY_APPLICATION" };
        }
      } else parsed = JSON.parse(payloadText);
    } catch {
      return undefined;
    }

    if (!rawEnvelope && !isEnvelopeLike(parsed)) return undefined;

    const envelope = rawEnvelope ?? (isEnvelopeLike(parsed) ? parsed : undefined);

    if (!envelope) return undefined;
    firstMessageMeasurement.received(envelope.header.eventId);
    const convId = envelope.header.convId;

    if (!convId) return undefined;

    if (isUnifiedTextChannel(convId) && !unifiedAppExperimentEnabled()) return undefined;
    emitIncomingEnvelopeTrace("accepted", {
      convId,
      eventId: envelope.header.eventId,
      payloadBytes: typeof payloadText === "string" ? textEncoder.encode(payloadText).byteLength : payloadText.byteLength,
      ratchetVersion: envelope.header.rk?.v ?? 0,
    });
    let targetConvId = convId;

    if (envelope.header.deviceDelivery) {
      if (!context) return { status: "FAILED", code: "OWNER_REQUIRED" };
      context = await bindDeviceDelivery(envelope, context);
    }

    let hasPeer = await ensurePeerContextFromConversation(targetConvId, context);
    let mapping: "direct" | "fallback" | "unavailable" = hasPeer ? "direct" : "unavailable";

    if (!hasPeer) {
      const fallbackConvId = await resolveFallbackConversationId(envelope, context);

      if (fallbackConvId) {
        targetConvId = fallbackConvId;
        hasPeer = await ensurePeerContextFromConversation(targetConvId, context);

        if (hasPeer) mapping = "fallback";

        if (hasPeer && fallbackConvId !== convId) {
          console.info("[sync] incoming envelope mapped to local conversation", {
            incomingConvId: convId,
            targetConvId: fallbackConvId,
            eventId: envelope.header.eventId,
          });
        }
      }
    }

    if (!hasPeer) {
      console.warn("[sync] incoming envelope dropped: peer context unavailable", { convId });
      emitIncomingEnvelopeTrace("dropped", {
        convId,
        eventId: envelope.header.eventId,
        reason: "peer-context-unavailable",
        mapping,
      });

      return undefined;
    }

    if (context && peerContexts.get(ownerKey(targetConvId, context))?.kind === "device" && await getAccountRootIdentity(context)) {
      context = await captureDeviceRegistryContext(context);
    }

    emitIncomingEnvelopeTrace("mapped", {
      convId,
      targetConvId,
      eventId: envelope.header.eventId,
      mapping,
    });

    const event: EnvelopeEvent = {
      eventId: envelope.header.eventId,
      convId: envelope.header.convId,
      authorDeviceId: envelope.header.authorDeviceId,
      lamport: envelope.header.lamport,
      ts: envelope.header.ts,
      ...(isRawEnvelope(envelope) ? { envelopeFormat: "nkce-v1" as const, envelopeBytes: encodeBinaryEnvelopeFrame(envelope),
        eventHash: await computeEnvelopeHash(envelope) } : { envelopeJson: typeof payloadText === "string" ? payloadText : "" }),
    };

    const [completion] = await applyEnvelopeEvents(targetConvId, [event], options?.diagnosticContext ?? { deliveryPath: "unknown" }, context);

    if (!receiveSucceeded(completion)) return completion;

    if (!envelope.header.deviceDelivery) {
      await refreshAuthenticatedReplyRoute(targetConvId, envelope, options?.replyRoute, context);
    }

    scheduleDeliveredReceipt(targetConvId, envelope, context);

    if (context) await context.vault.assertMain();
    emitIncomingEnvelopeTrace("processed", {
      convId,
      targetConvId,
      eventId: envelope.header.eventId,
    });

    return completion;
  } catch { return { status: "FAILED", code: "RECEIVE_APPLICATION_FAILED" }; }
};

const applyEnvelopeEvents = async (convKeyId: string, events: EnvelopeEvent[], diagnosticContext?: DeliveryContext, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const accountId = context?.owner.accountId ?? getActiveAccountId();

  if (context && nativeRatchetCasEnabled()) return [{ status: "FAILED", code: "ORDINARY_OWNER_REQUIRED" } as const];

  try {
    return await withReceiveChain(accountId, convKeyId, () => applyEnvelopeEventsSerial(convKeyId, events, diagnosticContext, accountId, context), context);
  } catch (error) {
    if (!context) throw error;

    return [{ status: "FAILED", code: "OWNER_OR_COMMIT_REJECTED" } as const];
  }
};

const applyEnvelopeEventsSerial = async (convKeyId: string, events: EnvelopeEvent[], diagnosticContext?: DeliveryContext, accountId?: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const outcomes = new Map<string, IncomingCompletion>();
  const recipient = context?.owner.accountId ?? accountId ?? getActiveAccountId();
  const unique = new Map<string, EnvelopeEvent>();

  for (const event of events) {
    if (!event?.eventId) {
      if (context) throw new Error("INVALID_SYNC_EVENT");
      continue;
    }

    if (event.envelopeFormat === "nkce-v1" && !context) throw new Error("OWNER_REQUIRED");

    if (context) {
      const envelope = readEventEnvelope(event);
      const previous = unique.get(event.eventId);

      const conflicting = previous && (previous.envelopeFormat !== event.envelopeFormat ||
        (previous.envelopeFormat === "nkce-v1" && event.envelopeFormat === "nkce-v1"
          ? !samePayloadBytes(previous.envelopeBytes, event.envelopeBytes) : previous.envelopeJson !== event.envelopeJson));

      if ((!isRawEnvelope(envelope) && !isEnvelopeLike(envelope)) || envelope.header.eventId !== event.eventId || envelope.header.convId !== event.convId ||
        envelope.header.authorDeviceId !== event.authorDeviceId || envelope.header.lamport !== event.lamport ||
        envelope.header.ts !== event.ts || !Number.isSafeInteger(event.lamport) || event.lamport < 0 ||
        !Number.isFinite(event.ts) || conflicting) {
        throw new Error("INVALID_SYNC_EVENT_BINDING");
      }

      if (isRawEnvelope(envelope) && !supportsOrdinaryBinaryEnvelope(envelope)) throw new Error("UNSUPPORTED_BINARY_APPLICATION");
    }

    // Decode relationships are diagnostics only, never Ratchet/replay admission.
    if (firstMessageMeasurement.observing()) {
      try {
        const decoded = readEventEnvelope(event);

        if (decoded?.header?.eventId === event.eventId) firstMessageMeasurement.stage(event.eventId, "message_decoded", diagnosticContext);
      } catch { /* Existing validation below remains authoritative. */ }
    }

    // SYNC_RES can deliver a message without going through direct envelope ingestion.
    firstMessageMeasurement.received(event.eventId);
    unique.set(event.eventId, event);
    outcomes.set(event.eventId, { status: "FAILED", code: "RECEIVE_NOT_APPLIED" });
  }

  const sorted = sortEventsDeterministic(Array.from(unique.values()));
  const convs = await listConversations(context?.vault);
  const conv = convs.find((item) => item.id === convKeyId) || null;

  for (const event of sorted) {
    if (event.envelopeFormat === "nkce-v1") {
      const peer = peerContexts.get(ownerKey(convKeyId, context));

      if (!context || !conv || conv.type === "group" || conv.participants.length !== 2 || peer?.kind !== "friend" ||
          peer.peerDeviceId !== event.authorDeviceId) continue;


      try { await authenticatedFriendIdentity(convKeyId, context); }
      catch { outcomes.set(event.eventId, { status: "FAILED", code: "FRIEND_AUTHENTICATION_REQUIRED" }); continue; }
    }


    if (context?.vault.authorizationMeta) {
      await context.vault.assertMain();
      const captured = context.vault.authorizationMeta;

      if ((await context.vault.db.meta.get(captured.key))?.value !== captured.value) {
        // A committed certificate can change authority within this batch. Retry the retained
        // signed response under a fresh capture, before consuming any subsequent Ratchet key.
        return [...outcomes].map(([eventId, result]) => receiveSucceeded(result) ? result : {
          status: "OWNED_DEFERRED" as const, accountId: recipient, eventId,
          recoveryOwner: { mechanism: "existing-inbox" as const, reference: eventId },
        });
      }
    }

    if (isUnifiedTextChannel(event.convId)) {
      if (!unifiedAppExperimentEnabled() || !conv) continue;

      try {
        const envelope = readEventEnvelope(event);
        const sender = await resolveSenderProfile(convKeyId, conv, await resolveLocalUserId(context), context);

        if (!sender) continue;
        const result = await receiveUnifiedAppText(conv, sender, requireLegacyApplicationEnvelope(envelope), event);

        if (result.outcome === "stored") {
          outcomes.set(event.eventId, { status: "STORED", accountId: recipient, eventId: event.eventId });

          for (const stage of ["verified", "decrypted", "stored"] as const) firstMessageMeasurement.stage(event.eventId, stage, diagnosticContext);
          firstMessageMeasurement.messageAuthenticated(event.eventId);
          firstMessageMeasurement.messageStored(event.eventId);

          if (diagnosticContext?.deliveryPath === "sync_response" && accountId) notifyAuthenticatedSyncTextStored(accountId);
        } else if (result.outcome === "duplicate") {
          outcomes.set(event.eventId, { status: "VERIFIED_DUPLICATE", accountId: recipient, eventId: event.eventId });
          firstMessageMeasurement.stage(event.eventId, "duplicate_rejected", diagnosticContext);
        }
      } catch {
        // No raw error, IDs, keys or plaintext; never fall back to the legacy owner.
        console.warn("[sync] disposable text admission failed");
      }

      continue;
    }

    if (!Number.isFinite(event.lamport)) {
      console.warn("[sync] invalid lamport", { convId: event.convId });
      continue;
    }

    const existing = await getEvent(event.eventId, context?.vault);

    if (existing?.envelopeFormat === "nkce-v1" && existing.localConvId !== convKeyId) {
      outcomes.set(event.eventId, { status: "FAILED", code: "OWNER_EVENT_MISMATCH" });
      continue;
    }

    if (existing && context && existing.applicationState === "stored" && existing.bodyType !== "msg" && existing.applicationCryptoCommitted) {
      const candidate = readEventEnvelope(event);

      if (existing.localConvId !== convKeyId || candidate.header.eventId !== existing.eventId || candidate.header.convId !== existing.convId ||
        await computeEnvelopeHash(candidate) !== existing.eventHash) continue;
      const verifyKey = await getPeerVerifyKey(convKeyId, candidate.header.authorDeviceId, context);

      if (!verifyKey || !await verifyEnvelopeSignature(candidate, verifyKey)) continue;
      await context.vault.assertMain();
      outcomes.set(event.eventId, { status: "VERIFIED_DUPLICATE", accountId: recipient, eventId: event.eventId });
      continue;
    }

    if (existing?.authenticatedBody_enc && context && (existing.applicationCryptoCommitted || (existing.ratchetVersion && existing.ratchetCommitFingerprint &&
      await hasReceiveCommit((() => { const header = readEventEnvelope(existing).header;
        const sid = header.deviceDelivery?.sessionId ?? header.friendSessionId;

        return sid ? freshRatchetChannel(existing.convId, sid) : existing.convId; })(), existing.ratchetVersion, existing.ratchetCommitFingerprint, getSecretStore(context.owner.session))))) {
      try {
        const candidate = readEventEnvelope(event);

        if (candidate.header.eventId !== existing.eventId || candidate.header.convId !== existing.convId ||
          await computeEnvelopeHash(candidate) !== existing.eventHash) continue;
        const verifyKey = await getPeerVerifyKey(convKeyId, candidate.header.authorDeviceId, context);

        if (!verifyKey || !await verifyEnvelopeSignature(candidate, verifyKey)) continue;

        if (candidate.header.deviceDelivery ? !await validateOwnedBody(convKeyId, conv, candidate,
          await readAuthenticatedApplication(existing, context.vault), context) : existing.localConvId !== convKeyId) continue;
        const body = await readAuthenticatedApplication(existing, context.vault);
        outcomes.set(event.eventId, await commitAppliedEnvelope(convKeyId, conv, candidate, body, diagnosticContext, undefined, context,
          existing.ratchetCommitFingerprint));
      } catch {
        try {
          await context.vault.assertMain();

          if (!await getEvent(event.eventId, context.vault)) throw new Error("RECOVERY_RECORD_MISSING");
          outcomes.set(event.eventId, { status: "OWNED_DEFERRED", accountId: recipient, eventId: event.eventId,
            recoveryOwner: { mechanism: "existing-event", reference: event.eventId } });
        } catch { outcomes.set(event.eventId, { status: "FAILED", code: "OWNER_OR_RECOVERY_REJECTED" }); }
      }

      continue;
    }

    // Existing rows from older builds lack bodyType; never infer that control/media
    // events require a message. A marked text event without a readable message is
    // an incomplete commit, not successful duplicate delivery.
    if (existing?.bodyType === "msg" && !existing.authenticatedBody_enc) {
      if (existing.applicationState !== "stored") throw new Error("RECEIVE_COMMIT_INCOMPLETE");
      let stored: Awaited<ReturnType<typeof getStoredMessage>>;

      try { stored = await getStoredMessage(existing.logicalMessageId ??
          readEventEnvelope(existing).header.friendDeliveryId ?? event.eventId, context?.vault); }
      catch { throw new Error("RECEIVE_COMMIT_INCOMPLETE"); }

      if (!stored) throw new Error("RECEIVE_COMMIT_INCOMPLETE");

      if (context && stored.convId !== (existing.logicalMessageId ? existing.localConvId : convKeyId)) throw new Error("RECEIVE_COMMIT_INCOMPLETE");

      if (existing.logicalMessageId && context && (!stored.logicalProof || !await verifyLogicalMessage(stored.logicalProof, context))) {
        throw new Error("LOGICAL_MESSAGE_AUTHORITY_REJECTED");
      }
    }

    if (existing?.bodyType === "msg" && existing.applicationState === "stored") {
      if (context) {
        await context.vault.assertMain();
        const candidate = readEventEnvelope(event);

        if (candidate.header.eventId !== existing.eventId || candidate.header.convId !== existing.convId ||
          await computeEnvelopeHash(candidate) !== existing.eventHash) continue;
        const verifyKey = await getPeerVerifyKey(convKeyId, candidate.header.authorDeviceId, context);

        if (!verifyKey || !await verifyEnvelopeSignature(candidate, verifyKey)) continue;
      }

      firstMessageMeasurement.stage(event.eventId, "duplicate_rejected", diagnosticContext);
      outcomes.set(event.eventId, { status: "VERIFIED_DUPLICATE", accountId: recipient, eventId: event.eventId });
      continue;
    }

    const seenLamport = getLamportSeen(event.convId, event.authorDeviceId, context);

    // An unseen authenticated event can arrive behind a later SYNC chunk. Owned replay
    // admission uses the exact durable event binding and Ratchet, not a high-water cursor.
    if (!context && event.lamport <= seenLamport) {
      firstMessageMeasurement.stage(event.eventId, "replay_rejected", diagnosticContext);
      console.warn("[sync] replay event dropped", {
        convId: event.convId,
        authorDeviceId: event.authorDeviceId,
        lamport: event.lamport,
      });
      emitIncomingEnvelopeTrace("dropped", {
        convId: event.convId,
        eventId: event.eventId,
        reason: "replay-lamport",
      });
      continue;
    }

    if (existing && !existing.authenticatedBody_enc && existing.bodyType !== "rcpt") {
      firstMessageMeasurement.stage(event.eventId, "duplicate_rejected", diagnosticContext);
      updateLamportSeen(event.convId, event.authorDeviceId, event.lamport, context);
      emitIncomingEnvelopeTrace("deduplicated", {
        convId: event.convId,
        eventId: event.eventId,
        reason: "event-already-persisted",
      });
      continue;
    }

    let envelope: IncomingEnvelope;

    try {
      envelope = readEventEnvelope(event);
    } catch (error) {
      console.warn("[sync] invalid envelope json", error);
      continue;
    }

    if (!envelope?.header || envelope.header.eventId !== event.eventId) {
      console.warn("[sync] invalid envelope header");
      continue;
    }

    try {
      const verifyKey = await getPeerVerifyKey(convKeyId, envelope.header.authorDeviceId, context);

      if (!verifyKey) {
        console.warn("[sync] missing verify key");
        emitIncomingEnvelopeTrace("dropped", {
          convId: event.convId,
          eventId: event.eventId,
          reason: "verify-key-missing",
        });
        continue;
      }

      const verified = await verifyEnvelopeSignature(envelope, verifyKey);

      if (!verified) {
        console.warn("[sync] signature invalid");
        emitIncomingEnvelopeTrace("dropped", {
          convId: event.convId,
          eventId: event.eventId,
          reason: "signature-invalid",
        });
        continue;
      }

      firstMessageMeasurement.stage(event.eventId, "verified", diagnosticContext);
      const rk = envelope.header.rk;

      if (context && !envelope.header.deviceDelivery && rk?.v !== 2) {
        outcomes.set(event.eventId, { status: "FAILED", code: "FRESH_SESSION_REQUIRED" }); continue;
      }

      const peerRatchetVersion = getPeerRatchetVersion(
        getPeerCapsForEvent(convKeyId, event.convId, context)
      );

      if (rk && rk.v === 2 && Number.isFinite(rk.i) && typeof rk.dh === "string") {
        const sid = envelope.header.deviceDelivery?.sessionId ?? envelope.header.friendSessionId;
        const active = context ? freshSessions.get(ownerKey(convKeyId, context))?.inbound : undefined;

        const currentAuthor = context && envelope.header.deviceDelivery ? await getAuthorizedDevice(event.authorDeviceId, context,
          envelope.header.deviceDelivery.author.accountRootIdentityPub) : undefined;

        if (envelope.header.deviceDelivery && (!context || !sid || active?.id !== sid || !currentAuthor ||
          !sameCertificate(envelope.header.deviceDelivery.author, currentAuthor) ||
          ![active.initiator, active.responder].some(cert => cert.kind !== "FRIEND_BOUND" && sameCertificate(cert, currentAuthor)))) {
          if (context && currentAuthor && sameCertificate(envelope.header.deviceDelivery.author, currentAuthor) &&
            !active) {
            const peer = peerContexts.get(ownerKey(convKeyId, context));

            if (peer?.deviceAuthorizationVersion === 2) await connectConversation(convKeyId, peer, context);
          }

          outcomes.set(event.eventId, { status: "FAILED", code: "FRESH_SESSION_REQUIRED" });
          continue;
        }

        if (!envelope.header.deviceDelivery && context) {
          const remote = await authenticatedFriendIdentity(convKeyId, context);
          const logicalId = envelope.header.friendDeliveryId;

          if (logicalId !== undefined && (typeof logicalId !== "string" || logicalId.length === 0 || logicalId.length > 256)) {
            outcomes.set(event.eventId, { status: "FAILED", code: "FRIEND_DELIVERY_BINDING_REJECTED" }); continue;
          }

          if (!sid || active?.id !== sid || !matchesFreshSession(active, await localFriendIdentity(context), remote)) {
            if (!active) {
              const peer = peerContexts.get(ownerKey(convKeyId, context));

              if (peer) await connectConversation(convKeyId, peer, context);
            }

            outcomes.set(event.eventId, { status: "FAILED", code: "FRESH_SESSION_REQUIRED" }); continue;
          }

          if (logicalId !== undefined && envelope.header.eventId !== await sessionDeliveryId(logicalId, active)) {
            outcomes.set(event.eventId, { status: "FAILED", code: "FRIEND_DELIVERY_BINDING_REJECTED" }); continue;
          }
        }

        if (peerRatchetVersion < 2) {
          console.warn("[sync] rk v2 received with caps mismatch; trying decrypt anyway", {
            convId: event.convId,
            eventId: event.eventId,
          });
        }

        logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "v2" });
        const ratchetBaseKey = await resolveRatchetBaseKey(convKeyId, envelope.header.convId, context);

        if (!ratchetBaseKey) {
          console.warn("[sync] missing conversation key");
          emitIncomingEnvelopeTrace("dropped", {
            convId: event.convId,
            eventId: event.eventId,
            reason: "conversation-key-missing",
            ratchetVersion: 2,
          });
          continue;
        }

        let body!: { type: string };

        if (context) await assertRatchetNotQuarantined(convKeyId, context);

        const recv = await tryRecvDhKey(sid ? freshRatchetChannel(envelope.header.convId, sid) : envelope.header.convId, ratchetBaseKey, rk, 50, async (key) => {
          body = await decryptEnvelope<{ type: string }>(key, envelope, verifyKey);
        }, context ? getSecretStore(context.owner.session) : undefined, Boolean(context));

        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: event.convId, eventId: event.eventId, mode: "v2" });
          emitIncomingEnvelopeTrace("deferred", {
            convId: event.convId,
            eventId: event.eventId,
            reason: "ratchet-key-deferred",
            ratchetVersion: 2,
          });
          continue;
        }

        logDecrypt("commit", { convId: event.convId, eventId: event.eventId, mode: "v2" });
        outcomes.set(event.eventId, await commitAppliedEnvelope(convKeyId, conv, envelope, body, diagnosticContext, recv.commit, context, recv.commitFingerprint));
        emitIncomingEnvelopeTrace("applied", {
          convId: event.convId,
          eventId: event.eventId,
          bodyType:
            body && typeof body === "object" && "type" in body
              ? String(body.type ?? "unknown")
              : "unknown",
          ratchetVersion: 2,
        });
        continue;
      }

      if (rk && rk.v === 1 && Number.isFinite(rk.i)) {
        if (peerRatchetVersion < 1) {
          console.warn("[sync] rk v1 received with caps mismatch; trying decrypt anyway", {
            convId: event.convId,
            eventId: event.eventId,
          });
        }

        logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "v1" });
        const ratchetBaseKey = await resolveRatchetBaseKey(convKeyId, envelope.header.convId, context);

        if (!ratchetBaseKey) {
          console.warn("[sync] missing conversation key");
          emitIncomingEnvelopeTrace("dropped", {
            convId: event.convId,
            eventId: event.eventId,
            reason: "conversation-key-missing",
            ratchetVersion: 1,
          });
          continue;
        }

        let authenticatedBody: { type: string } | undefined;

        if (context) await assertRatchetNotQuarantined(convKeyId, context);

        const recv = await tryRecvKey(envelope.header.convId, ratchetBaseKey, rk.i, 50, async (key) => {
          authenticatedBody = await decryptEnvelope<{ type: string }>(key, envelope, verifyKey);
        }, context ? getSecretStore(context.owner.session) : undefined, Boolean(context));

        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: event.convId, eventId: event.eventId, mode: "v1" });
          emitIncomingEnvelopeTrace("deferred", {
            convId: event.convId,
            eventId: event.eventId,
            reason: "ratchet-key-deferred",
            ratchetVersion: 1,
          });
          continue;
        }

        const body = nativeRatchetCasEnabled()
          ? authenticatedBody!
          : await decryptEnvelope<{ type: string }>(recv.msgKey, envelope, verifyKey);

        logDecrypt("ok", { convId: event.convId, eventId: event.eventId, mode: "v1" });
        outcomes.set(event.eventId, await commitAppliedEnvelope(convKeyId, conv, envelope, body, diagnosticContext, recv.commit, context, recv.commitFingerprint));
        emitIncomingEnvelopeTrace("applied", {
          convId: event.convId,
          eventId: event.eventId,
          bodyType:
            body && typeof body === "object" && "type" in body
              ? String(body.type ?? "unknown")
              : "unknown",
          ratchetVersion: 1,
        });
        continue;
      }

      const conversationKey = await resolveLegacyKey(convKeyId, context);

      if (!conversationKey) {
        console.warn("[sync] missing conversation key");
        emitIncomingEnvelopeTrace("dropped", {
          convId: event.convId,
          eventId: event.eventId,
          reason: "conversation-key-missing",
          ratchetVersion: 0,
        });
        continue;
      }

      logDecrypt("path", { convId: event.convId, eventId: event.eventId, mode: "legacy" });

      const body = await decryptEnvelope<{ type: string }>(
        conversationKey,
        envelope,
        verifyKey
      );

      logDecrypt("ok", { convId: event.convId, eventId: event.eventId, mode: "legacy" });
      outcomes.set(event.eventId, await commitAppliedEnvelope(convKeyId, conv, envelope, body, diagnosticContext, undefined, context));
      emitIncomingEnvelopeTrace("applied", {
        convId: event.convId,
        eventId: event.eventId,
        bodyType:
          body && typeof body === "object" && "type" in body
            ? String(body.type ?? "unknown")
            : "unknown",
        ratchetVersion: 0,
      });
    } catch (error) {
      console.warn("[sync] decrypt/apply failed", error);

      if (context) await retainRatchetQuarantine(convKeyId, context, error);
      firstMessageMeasurement.stage(event.eventId, "failed", diagnosticContext);
      emitIncomingEnvelopeTrace("failed", {
        convId: event.convId,
        eventId: event.eventId,
        reason: "decrypt-or-apply-failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String(error.code ?? "")
            : undefined,
      });
      outcomes.set(event.eventId, { status: "FAILED", code: "DECRYPT_OR_APPLY_FAILED" });

      if (!context && error instanceof Error && error.message === "RECEIVE_COMMIT_INCOMPLETE") throw error;

      if (!context) throwIfCryptoStorageFailure(error);
    }
  }

  return Array.from(outcomes.values());
};

const sendFrame = async (convId: string, frame: Frame, context?: ReceiveContext, prepareOnly = false) => {
  try {
    await context?.vault.assertMain();
    const endpoint = peerContexts.get(ownerKey(convId, context));

    if (context && endpoint?.deviceAuthorizationVersion === 2) {
      context = await captureDeviceRegistryContext(context);
      const own = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

      if (!own || !endpoint.peerDeviceId) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
      frame.deviceDelivery = { v: 2, recipientDeviceId: endpoint.peerDeviceId, author: own };
    }

    if (!await isDeviceSyncAllowed(convId, "send-control", context)) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");

    if (context) {
      const identity = peerContexts.get(ownerKey(convId, context))?.identityPub;

      if (!identity) throw new Error("CONTROL_PEER_BINDING_UNAVAILABLE");
      const controlNonce = frame.controlNonce ?? (frame.type === "ACK" ? frame.nonce : createNonce());

      const payload = { ...controlPayload(frame), convId, controlVersion: 2 as const,
        identityPub: encodeBase64Url(await getIdentityPublicKey(context)), deviceId: getOrCreateDeviceId(context),
        recipientIdentityPub: identity, controlNonce, controlTs: frame.controlTs ?? Date.now() };

      const stored = await context.vault.db.outbox.get(`control:${convId}:${frame.type}:${controlNonce}`);

      if (stored) {
        if (stored.ownerAccountId !== context.owner.accountId || stored.recipientIdentityPub !== identity) throw new Error("OWNER_OUTBOX_MISMATCH");
        const previous = JSON.parse(legacyOutboxCiphertext(stored)) as Frame;
        const { controlTs: oldTs, ...old } = controlPayload(previous);
        const { controlTs: newTs, ...next } = payload;
        void oldTs; void newTs;

        if (encodeBase64Url(canonicalBytes(old)) !== encodeBase64Url(canonicalBytes(next))) throw new Error("CONTROL_RETRY_CONFLICT");
        Object.assign(frame, previous);
      } else Object.assign(frame, { ...payload, sig: await signHandshake(payload, context) });
    }

    const bytes = toBytes(frame);

    if (syncTransportOverride) {
      if (prepareOnly) return;
      await syncTransportOverride.send(convId, bytes);
      await context?.vault.assertMain();

      return;
    }

    if (context) {
      await ensurePeerContextFromConversation(convId, context);
      const conv = (await listConversations(context.vault)).find(item => item.id === convId) ?? null;
      const peer = await resolveSenderProfile(convId, conv, await resolveLocalUserId(context), context);
      const endpoint = peerContexts.get(ownerKey(convId, context));

      const device = endpoint?.deviceAuthorizationVersion === 2 && await getAccountRootIdentity(context)
        ? await getAuthorizedDevice(endpoint.peerDeviceId ?? "", context, endpoint.accountRootIdentity) : null;

      const hints = device?.route ?? peer?.routingHints;
      const identity = device?.identityPub ?? peer?.identityPub;

      if (!identity || !hints?.deviceId || !hints.onionAddr) throw new Error("OWNER_PEER_ROUTE_UNAVAILABLE");
      const id = `control:${convId}:${frame.type}:${frame.controlNonce}`;
      let stored = await getOutbox(id, context.vault);

      if (!stored) {
        const now = Date.now();

        const record = { id, convId, ciphertext: textDecoder.decode(bytes), priority: "high" as const,
          createdAtMs: now, expiresAtMs: Number(frame.controlTs) + HANDSHAKE_NONCE_TTL_MS,
          nextAttemptAtMs: now + SYNC_FLOW_ACK_TIMEOUT_MS, attempts: 0, status: "pending" as const,
          ownerAccountId: context.owner.accountId, recipientIdentityPub: identity,
          toDeviceId: hints.deviceId, torOnion: hints.onionAddr };

        await enqueueOutgoing(record, context.vault);
        stored = await getOutbox(id, context.vault);
      }

      if (!stored) throw new Error("CONTROL_RESPONSE_FAILED");

      if (!prepareOnly && stored.status !== "acked") {
        const result = await sendOutboxRecord(stored, { access: context.vault });

        if (!result.ok && !result.retryable) throw new Error("CONTROL_RESPONSE_FAILED");
      }

      await context.vault.assertMain();

      return;
    }

    if (typeof window !== "undefined" && window.nkc?.activateAccountSession) throw new Error("OWNER_REQUIRED");
    await sendToConversation(convId, bytes);
  } catch (error) {
    console.warn("[sync] send failed", error);

    if (context) throw error;
    throwIfCryptoStorageFailure(error);
  }
};

const canUseFlowControl = (convId: string, context?: ReceiveContext) => getPeerCaps(convId, context).sync.v >= 2;

const createSyncResponseFrames = (
  base: Omit<SyncResFrame, "events" | "next" | "flow">,
  events: EnvelopeEvent[],
  next: Record<string, number>,
  flowControl: boolean,
  reservedBytes = 0
): SyncResFrame[] => {
  if (!flowControl || events.length <= MAX_SYNC_CHUNK_EVENTS && toBytes({ ...base, events, next }).byteLength <= MAX_SYNC_CHUNK_BYTES - reservedBytes) {
    return [{ ...base, events, next }];
  }

  const sessionId = createId();
  const chunks: EnvelopeEvent[][] = [];
  let current: EnvelopeEvent[] = [];

  for (const event of events) {
    const candidate = [...current, event];

    const candidateFrame: SyncResFrame = {
      ...base,
      events: candidate,
      next: {},
      flow: { sessionId, chunkIndex: chunks.length, totalChunks: 1, final: false },
    };

    const candidateTooLarge =
      current.length > 0 &&
      (candidate.length > MAX_SYNC_CHUNK_EVENTS ||
        toBytes(candidateFrame).byteLength > MAX_SYNC_CHUNK_BYTES - reservedBytes);

    if (candidateTooLarge) {
      chunks.push(current);
      current = [event];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current);

  const totalChunks = chunks.length;

  return chunks.map((chunk, chunkIndex) => {
    const final = chunkIndex === totalChunks - 1;

    return {
      ...base,
      events: chunk,
      next: final ? next : {},
      flow: { sessionId, chunkIndex, totalChunks, final },
    };
  });
};

const clearFlowSession = (sessionId: string) => {
  const session = outgoingFlowSessions.get(sessionId);

  if (!session) return;
  session.inFlight.forEach((entry) => clearTimeout(entry.timer));
  outgoingFlowSessions.delete(sessionId);
};

const scheduleFlowRetry = (sessionId: string, chunkIndex: number) => {
  const session = outgoingFlowSessions.get(sessionId);

  if (!session) return;
  const entry = session.inFlight.get(chunkIndex);

  if (!entry) return;
  entry.timer = setTimeout(() => {
    const current = outgoingFlowSessions.get(sessionId);
    const currentEntry = current?.inFlight.get(chunkIndex);

    if (!current || !currentEntry) return;

    if (currentEntry.attempts >= SYNC_FLOW_MAX_RETRIES) {
      // Stop active retries without discarding a still-valid late ACK and unsent frames.
      currentEntry.timer = setTimeout(() => clearFlowSession(sessionId), Math.max(0, current.expiresAt - Date.now()));

      return;
    }

    const frame = current.frames[chunkIndex];

    if (!frame) {
      current.inFlight.delete(chunkIndex);
      void pumpFlowSession(sessionId).catch(() => clearFlowSession(sessionId));

      return;
    }

    currentEntry.attempts += 1;
    void sendFrame(current.convId, frame, current.context).then(() => {
      scheduleFlowRetry(sessionId, chunkIndex);
    }).catch(() => clearFlowSession(sessionId));
  }, SYNC_FLOW_ACK_TIMEOUT_MS);
};

const pumpFlowSession = async (sessionId: string) => {
  const session = outgoingFlowSessions.get(sessionId);

  if (!session) return;
  session.context?.vault.assertLocal();
  const sends: Promise<void>[] = [];

  while (
    session.nextToSend < session.frames.length &&
    session.inFlight.size < SYNC_FLOW_WINDOW
  ) {
    const chunkIndex = session.nextToSend;
    session.nextToSend += 1;
    const timer = setTimeout(() => undefined, 0);
    clearTimeout(timer);
    session.inFlight.set(chunkIndex, { attempts: 1, timer });
    const frame = session.frames[chunkIndex];

    if (!frame) {
      session.inFlight.delete(chunkIndex);
      continue;
    }

    sends.push(sendFrame(session.convId, frame, session.context).then(() => {
      scheduleFlowRetry(sessionId, chunkIndex);
    }));
  }

  try { await Promise.all(sends); } catch (error) { clearFlowSession(sessionId); throw error; }

  if (session.nextToSend >= session.frames.length && session.inFlight.size === 0) {
    outgoingFlowSessions.delete(sessionId);
  }
};

const sendSyncResponseFrames = async (convId: string, frames: Array<SyncResFrame & Partial<ControlAuthentication>>, context?: ReceiveContext) => {
  if (frames.length === 0) return;

  if (frames.length === 1 || !frames[0].flow) {
    await sendFrame(convId, frames[0], context);

    return;
  }

  // The window is an optimization; every prepared frame remains in the existing Outbox after restart.
  if (context) for (const frame of frames) await sendFrame(convId, frame, context, true);
  const sessionId = sessionKey(frames[0].flow.sessionId, context);
  clearFlowSession(sessionId);
  outgoingFlowSessions.set(sessionId, {
    convId,
    context,
    frames,
    expiresAt: Math.min(...frames.map(frame => frame.controlTs ?? Date.now())) + HANDSHAKE_NONCE_TTL_MS,
    nextToSend: 0,
    inFlight: new Map(),
  });
  await pumpFlowSession(sessionId);
};

const handleSyncFlowAck = async (convId: string, frame: SyncFlowAckFrame, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const key = sessionKey(frame.sessionId, context);
  const session = outgoingFlowSessions.get(key);

  if (!session || session.convId !== convId || !Number.isSafeInteger(frame.chunkIndex) || frame.chunkIndex < 0 ||
    frame.chunkIndex >= session.frames.length) return false;
  const entry = session.inFlight.get(frame.chunkIndex);

  if (!entry || frame.receivedEvents !== session.frames[frame.chunkIndex].events.length) return false;

  if (entry) clearTimeout(entry.timer);
  session.inFlight.delete(frame.chunkIndex);
  await pumpFlowSession(key);

  return true;
};

/** Bootstrap through the existing ordered signed flow before logical history depends on these local bindings. */
const prepareLinkedMetadataEvents = async (target: DeviceAuthorization, knownIds: string[], context: ReceiveContext, limit = Infinity, historyRequestId?: string) => {
  const root = await getAccountRootIdentity(context);

  if (!root || target.accountRootIdentityPub !== root) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
  const channelId = deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId);

  const partner: UserProfile = { id: target.deviceId, kind: "friend", displayName: "", status: "", theme: "dark",
    identityPub: root, dhPub: target.dhPub };

  const conv: Conversation = { id: channelId, participants: [], name: "", pinned: false, unread: 0, hidden: false,
    muted: false, blocked: false, lastTs: 0, lastMessage: "" };

  const ids = new Set<string>();

  const prepare = async (body: unknown) => {
    const identity = encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(body)));
    const eventId = await deviceDeliveryIdentity(`metadata:${identity}`, target, getOrCreateDeviceId(context));

    if (!knownIds.includes(eventId)) {
      const prepared = await sendOwnedDirectEnvelope(conv, partner, body, "high", {
        context, deviceTarget: target, v2Only: true, reuseEvent: true, prepareOnly: true, eventId, historyRequestId });

      ids.add(prepared.header.eventId);

      if (ids.size > limit) throw new Error("HISTORY_INVENTORY_LIMIT");
    }
  };

  const profiles = await listProfiles(context.vault);
  const users = profiles.filter(profile => profile.kind === "user");

  if (users.length !== 1) throw new Error("OWNER_PROFILE_MISMATCH");

  const avatar = users[0].avatarRef?.size && users[0].avatarRef.size <= PROFILE_AVATAR_SYNC_MAX_BYTES
    ? await loadProfilePhoto(users[0].avatarRef, context.vault) : null;

  await prepare({ type: "account_profile", v: 2, accountRootIdentity: root,
    profile: { displayName: users[0].displayName, status: users[0].status,
      ...(avatar && avatar.size <= PROFILE_AVATAR_SYNC_MAX_BYTES ? { avatar: {
          mime: avatar.type, data: encodeBase64Url(new Uint8Array(await avatar.arrayBuffer())) } } : {}) },
    ts: Math.max(Number(users[0].profileUpdatedAt ?? 0), Number(users[0].updatedAt ?? users[0].createdAt ?? 0)) });

  for (const authorization of Object.values(await getAuthorizedDeviceRegistry(context))) {
    await prepare({ type: "account_device", v: 2, authorization });
  }

  for (const contact of profiles.filter(profile => profile.kind === "friend" && profile.identityPub && profile.dhPub &&
    ["normal", "blocked", "deleted"].includes(profile.friendStatus ?? "normal"))) {
    await prepare({ type: "contact", v: 2, profile: {
        friendId: computeFriendId(decodeBase64Url(contact.identityPub!)), identityPub: contact.identityPub, dhPub: contact.dhPub,
        displayName: contact.displayName, status: contact.status,
        friendStatus: contact.verification?.status === "key_changed" || ["blocked", "changed"].includes(contact.trust?.status ?? "") ? "blocked" : contact.friendStatus ?? "normal",
        routingHints: sanitizeRoutingHints(contact.routingHints), primaryDeviceId: contact.primaryDeviceId } });

    if (contact.friendStatus !== "normal" || contact.trust?.status !== "trusted" || contact.verification?.status === "key_changed") continue;

    for (const authorization of Object.values(await getAuthorizedDeviceRegistry(context, contact.identityPub))) {
      await prepare({ type: "account_device", v: 2, authorization });
    }
  }

  for (const conversation of await listConversations(context.vault)) {
    const identities: Array<string | undefined> = conversation.participants.map((id): string | undefined => {
      const profile = profiles.find(item => item.id === id);

      return profile?.kind === "user" ? root : profile?.identityPub;
    });

    if (identities.some(identity => !identity) || !identities.includes(root) || conversation.blocked || conversation.hidden ||
      new Set(identities).size !== identities.length || identities.length < 2) continue;
    const type = conversation.type === "group" ? "group" : "direct";

    if (type === "direct" && identities.length !== 2) continue;
    const id = type === "group" ? conversation.id : await logicalConversationIdentity(...identities as [string, string]);
    await prepare({ type: "conv", v: 2, conv: { id, type, name: conversation.name }, memberIdentities: identities });
  }

  return ids;
};

const handleSyncReq = async (convId: string, frame: Extract<Frame, { type: "SYNC_REQ" }>, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const allowed = await isDeviceSyncAllowed(convId, "sync_req", context);

  if (!allowed) return false;

  const peer = peerContexts.get(ownerKey(convId, context));
  let historyEvents: Set<string> | undefined;

  if (context && peer?.kind === "friend" && peer.deviceAuthorizationVersion !== 2 && frame.scope === "conv") {
    const profiles = await listProfiles(context.vault), conv = (await listConversations(context.vault)).find(row => row.id === convId);
    const partner = profiles.find(row => row.kind === "friend" && conv?.participants.includes(row.id) && row.identityPub === peer.identityPub && row.dhPub === peer.dhPub);

    if (!conv || !partner) throw new Error("OWNER_PEER_MISMATCH");
    const own = getOrCreateDeviceId(context), identities = new Set<string>();
    historyEvents = new Set();

    // Only the original sender rewraps its Vault-encrypted body; old ciphertext is never relabelled.
    for (const event of await listEventsByConv(convId, context.vault)) {
      if (event.authorDeviceId !== own) continue;
      const original = readEventEnvelope(event);
      const id = original.header.friendDeliveryId ?? event.eventId;

      if (identities.has(id)) continue;

      if (original.header.deviceDelivery || original.header.convId !== convId || original.header.eventId !== event.eventId ||
        !await verifyEnvelopeSignature(original, await getIdentityPublicKey(context)) || await computeEnvelopeHash(original) !== event.eventHash)
        throw new Error("OWNER_EVENT_MISMATCH");
      const message = event.outgoingBody_enc ? undefined : await getStoredMessage(id, context.vault);

      if (!event.outgoingBody_enc && (!message || message.convId !== convId ||
        message.senderId !== profiles.find(row => row.kind === "user")?.id || message.logicalProof)) continue;

      const body = event.outgoingBody_enc
        ? await decryptJsonRecord<{ type?: string }>(context.vault.key, event.eventId, `outgoing:${event.eventHash}`, event.outgoingBody_enc)
        : { type: "msg", text: message!.text, ...(message!.media ? { media: message!.media } : {}),
          ...(message!.clientBatchId ? { clientBatchId: message!.clientBatchId } : {}) };

      if (body.type !== "msg" && body.type !== "media") continue;
      identities.add(id);

      const prepared = await sendOwnedDirectEnvelope(conv, partner, body, "normal", { context, eventId: id,
        originalTs: original.header.ts, reuseEvent: true, prepareOnly: true });

      historyEvents.add(prepared.header.eventId);
    }
  }

  if (context && peer?.deviceAuthorizationVersion === 2 && frame.scope === "global") {
    if (!await isApprovedLinkedDevicePeer(convId, "logical-history", context)) return false;

    if (frame.inventoryVersion !== undefined && frame.inventoryVersion !== 1) return false;

    if (!frame.history || frame.history.v !== 2 || !["ALL", "LAST_30_DAYS", "NEW_ONLY"].includes(frame.history.policy) ||
      !Number.isSafeInteger(frame.history.fromTs) || frame.history.fromTs < 0 || frame.history.fromTs > Date.now() ||
      (frame.history.policy === "ALL" && frame.history.fromTs !== 0) ||
      !Array.isArray(frame.knownEventIds) || frame.knownEventIds.length > 512 ||
      frame.knownEventIds.some(id => typeof id !== "string" || !id || id.length > 128) ||
      new Set(frame.knownEventIds).size !== frame.knownEventIds.length) return false;
    const target = await getAuthorizedDevice(peer.peerDeviceId ?? "", context);

    if (!target) return false;

    if (frame.resumeInventory) {
      if (frame.inventoryVersion !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(frame.resumeInventory.requestId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(frame.resumeInventory.snapshotId)) return false;
      const pages = await loadHistoryInventory(convId, frame.resumeInventory.requestId, context);
      const own = await getAuthorizedDevice(getOrCreateDeviceId(context), context), binding = pages[0].binding;

      if (!own || pages[0].snapshotId !== frame.resumeInventory.snapshotId || binding.accountIdentity !== own.accountRootIdentityPub ||
        binding.requesterDeviceId !== target.deviceId || binding.sourceDeviceId !== own.deviceId || binding.sourceEpoch !== own.epoch ||
        binding.sourceIdentityPub !== own.identityPub || encodeBase64Url(canonicalBytes(binding.history)) !== encodeBase64Url(canonicalBytes(frame.history))) return false;
      const conversations = await listConversations(context.vault), profiles = await listProfiles(context.vault), responses: SyncResFrame[] = [];

      for (const page of pages) {
        const events: EnvelopeEvent[] = [];

        for (const item of page.items) {
          const event = await getEvent(item.eventId, context.vault);

          if (!event?.outgoingBody_enc || event.authorDeviceId !== own.deviceId || event.eventHash !== item.eventHash) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");
          const body = await decryptJsonRecord(context.vault.key, event.eventId, `outgoing:${event.eventHash}`, event.outgoingBody_enc);

          if (await historyBodyHash(body) !== item.bodyHash) throw new Error("HISTORY_INVENTORY_CONFLICT");

          const conv = conversations.find(row => row.id === event.localConvId) ?? { id: convId, participants: [], name: "",
            pinned: false, unread: 0, hidden: false, muted: false, blocked: false, lastTs: 0, lastMessage: "" };

          const metadata = body as { type?: string; v?: number };

          const partner = profiles.find(row => row.kind === "friend" && conv.participants.includes(row.id)) ??
            (metadata.v === 2 && ["account_device", "account_profile", "contact", "conv"].includes(metadata.type ?? "")
              ? { id: target.deviceId, kind: "friend" as const, displayName: "", status: "", theme: "dark" as const,
                identityPub: own.accountRootIdentityPub, dhPub: target.dhPub } : undefined);

          if (!partner) throw new Error("OWNER_PEER_MISMATCH");

          const prepared = await sendOwnedDirectEnvelope(conv, partner, body, "high", { context, deviceTarget: target,
            v2Only: true, reuseEvent: true, prepareOnly: true, eventId: item.deliveryId, originalTs: event.ts, historyRequestId: binding.requestId });

          events.push({ ...prepared.header, envelopeJson: prepared.envelopeJson });
        }

        responses.push({ type: "SYNC_RES", scope: "global", convId, replyTo: frame.controlNonce, events, next: {}, inventory: page,
          flow: { sessionId: page.snapshotId, chunkIndex: page.page, totalChunks: pages.length, final: page.page === pages.length - 1 } });
      }

      if (responses.some(row => toBytes(row).byteLength > MAX_SYNC_CHUNK_BYTES - 4096)) throw new Error("HISTORY_INVENTORY_LIMIT");
      await sendSyncResponseFrames(convId, responses, context);

      return true;
    }

    const knownIds = frame.inventoryVersion === 1 ? [] : frame.knownEventIds;
    const historyRequestId = frame.inventoryVersion === 1 ? frame.controlNonce : undefined;
    historyEvents = await prepareLinkedMetadataEvents(target, knownIds, context, frame.inventoryVersion === 1 ? HISTORY_MAX_ITEMS : Infinity, historyRequestId);
    const profiles = await listProfiles(context.vault);

    for (const conversation of await listConversations(context.vault)) {
      const partner = profiles.find(profile => profile.kind === "friend" && conversation.participants.includes(profile.id));

      if (!partner) continue;
      const eligibleMessages = new Set<string>();

      for (const message of await listMessagesByConv(conversation.id, context.vault)) {
        if (!message.logicalProof || message.ts < frame.history.fromTs) continue;
        eligibleMessages.add(message.id);
        const eventId = await deviceDeliveryIdentity(message.id, target, getOrCreateDeviceId(context));

        if (!knownIds.includes(eventId)) {
          const prepared = await sendOwnedDirectEnvelope(conversation, partner, message.logicalProof, "high", {
            context, deviceTarget: target, v2Only: true, reuseEvent: true, prepareOnly: true, eventId, historyRequestId });

          historyEvents.add(prepared.header.eventId);

          if (frame.inventoryVersion === 1 && historyEvents.size > HISTORY_MAX_ITEMS) throw new Error("HISTORY_INVENTORY_LIMIT");
        }
        // History carries the signed attachment manifest; original bytes require a separate explicit transfer.
      }

      for (const receipt of await context.vault.db.receipts.where("convId").equals(conversation.id).toArray()) {
        if (receipt.logicalDelivered_enc && eligibleMessages.has(receipt.msgId)) {
          const proof = await decryptJsonRecord<LogicalDelivered>(context.vault.key, receipt.id, "receipt", receipt.logicalDelivered_enc);

          if (await verifyLogicalDelivered(proof, context)) {
            const eventId = await deviceDeliveryIdentity(proof.id, target, getOrCreateDeviceId(context));

            if (!knownIds.includes(eventId)) {
              const prepared = await sendOwnedDirectEnvelope(conversation, partner, proof, "normal", {
                context, deviceTarget: target, v2Only: true, reuseEvent: true, prepareOnly: true, eventId, historyRequestId });

              historyEvents.add(prepared.header.eventId);

              if (frame.inventoryVersion === 1 && historyEvents.size > HISTORY_MAX_ITEMS) throw new Error("HISTORY_INVENTORY_LIMIT");
            }
          }
        }

        if (!receipt.logicalRead_enc || !receipt.anchorMsgId || !eligibleMessages.has(receipt.anchorMsgId)) continue;
        const read = await decryptJsonRecord<LogicalRead>(context.vault.key, receipt.id, "receipt", receipt.logicalRead_enc);

        if (!await verifyLogicalRead(read, context)) continue;
        const eventId = await deviceDeliveryIdentity(read.id, target, getOrCreateDeviceId(context));

        if (!knownIds.includes(eventId)) {
          const prepared = await sendOwnedDirectEnvelope(conversation, partner, read, "normal", {
            context, deviceTarget: target, v2Only: true, reuseEvent: true, prepareOnly: true, eventId, historyRequestId });

          historyEvents.add(prepared.header.eventId);

          if (frame.inventoryVersion === 1 && historyEvents.size > HISTORY_MAX_ITEMS) throw new Error("HISTORY_INVENTORY_LIMIT");
        }
      }
    }
  }

  const scopeConvId =
    frame.scope === "contacts"
      ? contactsLogId(frame.convId ?? convId)
      : frame.scope === "conversations"
        ? conversationsLogId(frame.convId ?? convId)
        : frame.scope === "global"
          ? globalLogId(frame.convId ?? convId)
          : frame.convId ?? convId;

  const all = context && peer?.deviceAuthorizationVersion === 2 && frame.scope === "global" && historyEvents
    ? (await context.vault.db.events.bulkGet([...historyEvents])).map(event => {
      if (!event || event.convId !== convId || event.authorDeviceId !== getOrCreateDeviceId(context)) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");

      return event;
    })
    : (await listEventsByConv(context && peer?.deviceAuthorizationVersion === 2 && frame.scope === "global" ? convId : scopeConvId, context?.vault, historyEvents))
      .filter(event => !historyEvents || event.authorDeviceId === getOrCreateDeviceId(context) && historyEvents.has(event.eventId));

  const since = frame.since ?? {};

  const events = all.filter((event) => {
    if (historyEvents) return frame.inventoryVersion === 1 || !(frame.knownEventIds ?? []).includes(event.eventId);

    if (context && peerContexts.get(ownerKey(convId, context))?.kind === "friend" &&
      event.authorDeviceId !== getOrCreateDeviceId(context)) return false;
    const lastSeen = since[event.authorDeviceId] ?? 0;

    return event.lamport > lastSeen;
  });

  const next = buildNextMap(all);

  const inventoried = Boolean(context && peer?.deviceAuthorizationVersion === 2 && frame.scope === "global" && frame.inventoryVersion === 1);

  if (inventoried && events.length > HISTORY_MAX_ITEMS) throw new Error("HISTORY_INVENTORY_LIMIT");

  const responseFrames = createSyncResponseFrames(
    {
      type: "SYNC_RES",
      scope: frame.scope,
      convId: frame.convId,
      ...(context ? { replyTo: frame.controlNonce } : {}),
    },
    sortEventsDeterministic(events.map((event) => toEnvelopeEvent(event))),
    next,
    canUseFlowControl(convId, context),
    inventoried ? 8192 : 0
  );

  if (inventoried && context && frame.history && frame.controlNonce && peer?.peerDeviceId) {
    const own = await getAuthorizedDevice(getOrCreateDeviceId(context), context);

    if (!own) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");

    const binding: HistoryBinding = { accountIdentity: own.accountRootIdentityPub, requesterDeviceId: peer.peerDeviceId,
      sourceDeviceId: own.deviceId, sourceIdentityPub: own.identityPub, sourceEpoch: own.epoch,
      requestId: frame.controlNonce, scope: "global", history: frame.history };

    const bodyHashes = new Map<string, string>();

    for (const stored of events) {
      if (!stored.outgoingBody_enc) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");
      const body = await decryptJsonRecord(context.vault.key, stored.eventId, `outgoing:${stored.eventHash}`, stored.outgoingBody_enc);
      bodyHashes.set(stored.eventId, await historyBodyHash(body));
    }

    const inventory = await buildHistoryInventory(binding, responseFrames.map(row => row.events), bodyHashes);

    for (const [index, row] of responseFrames.entries()) {
      row.inventory = inventory[index];
      row.flow = { sessionId: inventory[index].snapshotId, chunkIndex: index, totalChunks: responseFrames.length, final: index === responseFrames.length - 1 };

      if (toBytes(row).byteLength > MAX_SYNC_CHUNK_BYTES - 4096) throw new Error("HISTORY_INVENTORY_LIMIT");
    }

    await retainHistoryInventorySnapshot(convId, inventory, binding, context);
  }

  await sendSyncResponseFrames(convId, responseFrames, context);

  return true;
};

const handleSyncRes = async (convId: string, frame: Extract<Frame, { type: "SYNC_RES" }>, diagnosticContext?: DeliveryContext, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const allowed = await isDeviceSyncAllowed(convId, "sync_res", context);

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
  const stored = frame.inventory && context ? await storedHistoryDeliveries(convId, frame.inventory, context) : new Set<string>();
  const pending = stored.size ? events.filter(event => !stored.has((readEventEnvelope(event)).header.deviceDelivery?.deliveryId ?? "")) : events;
  const completions = await applyEnvelopeEvents(convId, pending, diagnosticContext ?? { deliveryPath: "sync_response" }, context);
  const failed = completions.find(result => !receiveSucceeded(result));

  if (failed) return failed;

  if (frame.inventory && context && !await advanceHistoryInventory(convId, frame.inventory, context)) {
    return { status: "OWNED_DEFERRED", accountId: context.owner.accountId, eventId: frame.controlNonce ?? "",
      recoveryOwner: { mechanism: "existing-inbox", reference: context.owner.operationId } } as const;
  }

  for (const event of events) scheduleDeliveredReceipt(convId, readEventEnvelope(event), context);

  if (context) await context.vault.assertMain();

  if (frame.flow) {
    await sendFrame(convId, {
      type: "SYNC_FLOW_ACK",
      sessionId: frame.flow.sessionId,
      chunkIndex: frame.flow.chunkIndex,
      receivedEvents: events.length,
      ...(context ? { replyTo: frame.controlNonce } : {}),
    }, context);
  }

  // Peer cursors are not proof that this recipient committed those events.
  if (context) return completions[0] ?? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const;

  if (frame.flow && !frame.flow.final) return completions[0];
  Object.entries(frame.next ?? {}).forEach(([deviceId, lamport]) => {
    if (!Number.isFinite(lamport)) return;
    updateLamportSeen(targetConvId, deviceId, lamport, context);
  });

  return completions[0];
};

const applyVerification = async (
  identityPub: string,
  deviceId?: string,
  profile?: HelloFrame["profile"],
  convId?: string, context?: ReceiveContext, application?: AuthenticatedProfileApplication
) => {
  context?.vault.assertLocal();
  const friend = await resolveFriendByIdentity(identityPub, context);

  if (!friend) return;

  if (friend.identityPub && friend.identityPub !== identityPub) {
    await saveProfile({
      ...friend,
      verification: {
        status: "key_changed",
        safetyNumber: friend.verification?.safetyNumber,
        verifiedAt: friend.verification?.verifiedAt,
      },
      friendStatus: "blocked",
      updatedAt: Date.now(),
    }, context?.vault);

    return;
  }

  const localIdentityPub = encodeBase64Url(await getIdentityPublicKey(context));
  const safetyNumber = await computeSafetyNumber(localIdentityPub, identityPub);
  const now = Date.now();

  const verifiedFriend: UserProfile = {
    ...friend,
    identityPub,
    primaryDeviceId: deviceId ?? friend.primaryDeviceId,
    routingHints: sanitizeRoutingHints({
      onionAddr: friend.routingHints?.onionAddr,
      deviceId: deviceId ?? friend.routingHints?.deviceId,
      inboxWriteToken: friend.routingHints?.inboxWriteToken,
    }),
    verification: {
      status: "verified",
      safetyNumber,
      verifiedAt: now,
    },
    reachability: deviceId
      ? { status: "ok", lastAttemptAt: now }
      : friend.reachability ?? { status: "unreachable", lastError: "Missing deviceId" },
    profileVcard: profile
      ? {
        displayName: profile.displayName,
        status: profile.status,
        avatarRef: profile.avatarRef,
        updatedAt: now,
      }
      : friend.profileVcard,
    updatedAt: now,
  };

  if (context && application && convId) {
    const localUserId = await resolveLocalUserId(context);
    const conv = (await listConversations(context.vault)).find(item => item.id === convId);

    if (!localUserId || !conv || conv.type === "group" || !conv.participants.includes(localUserId)) throw new Error("CONTROL_PEER_BINDING_UNAVAILABLE");
    const repaired = { ...conv, participants: conv.participants.map(id => id === localUserId ? id : verifiedFriend.id) };
    await commitAuthenticatedProfile(verifiedFriend, friend, application, context.vault, repaired, conv);

    return;
  }

  await saveProfile(verifiedFriend, context?.vault);

  if (convId) {
    await repairDirectConversationPeerBinding(
      convId,
      verifiedFriend,
      await resolveLocalUserId(context), context
    );
  }
};

const resumeCertifiedStorageReceipts = async (convId: string, context?: ReceiveContext, chunkAfter = "") => {
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!context || !peer || !await canAutomaticallySendDeliveredReceipt(convId, context)) return;

  // Chunk bytes stay outside history sync; only their stored receipt metadata is revisited.
  const chunks = await context.vault.db.events.where("convId").equals(convId).filter(event =>
    event.eventId > chunkAfter && Boolean(event.mediaReceipt_enc) && !event.mediaReceiptQueued &&
    event.applicationState === "stored" && event.authorDeviceId === peer.peerDeviceId).limit(256).toArray();

  for (const event of chunks) {
    await produceDeliveredReceipt(convId, readEventEnvelope(event), context);
  }

  if (chunks.length === 256) setTimeout(() => { void resumeCertifiedStorageReceipts(convId, context, chunks[chunks.length - 1].eventId)
      .catch(() => { console.warn("[sync] media storage receipts deferred"); }); }, 0);

  if (chunkAfter || peer.deviceAuthorizationVersion !== 2) return;

  // ponytail: scan existing channel history at negotiation; index pending receipts if history cost becomes measurable.
  for (const event of await listEventsByConv(convId, context.vault)) {
    if (event.applicationState !== "stored" || event.bodyType !== "msg" || event.authorDeviceId !== peer.peerDeviceId ||
      await context.vault.db.outbox.get(`delivered:${event.eventId}`)) continue;
    const envelope = readEventEnvelope(event);

    if (envelope.header.deviceDelivery) await produceDeliveredReceipt(convId, envelope, context);
  }
};

const handleHello = async (convId: string, frame: Extract<Frame, { type: "HELLO" }>, context?: ReceiveContext) => {
  context?.vault.assertLocal();

  if (!/^[A-Za-z0-9_-]{16,256}$/.test(frame.nonce)) {
    console.warn("[sync] invalid HELLO nonce", { convId });

    return;
  }

  const pinnedPeerIdentity = peerContexts.get(ownerKey(convId, context))?.identityPub;

  if (pinnedPeerIdentity && pinnedPeerIdentity !== frame.identityPub) {
    console.warn("[sync] dropped HELLO with pinned identity mismatch", { convId });

    return;
  }

  const payload = {
    type: "HELLO",
    identityPub: frame.identityPub,
    deviceId: frame.deviceId,
    nonce: frame.nonce,
    caps: frame.caps ?? null,
  };

  const legacyPayload = {
    type: "HELLO",
    identityPub: frame.identityPub,
    deviceId: frame.deviceId,
    nonce: frame.nonce,
  };

  const ok = frame.controlVersion === 2 ? await verifyHandshake(controlPayload(frame), frame.sig, frame.identityPub) : await verifyHandshakeCompat(
    payload,
    legacyPayload,
    frame.sig,
    frame.identityPub,
    Boolean(frame.caps)
  );

  if (!ok) {
    console.warn("[sync] invalid HELLO signature", { convId });

    return;
  }

  const now = Date.now();

  for (const [key, seenAt] of seenHelloNonces) {
    if (now - seenAt > HANDSHAKE_NONCE_TTL_MS) seenHelloNonces.delete(key);
  }

  const replayKey = sessionKey(`HELLO:${frame.identityPub}:${frame.nonce}`, context);

  if (seenHelloNonces.has(replayKey)) {
    countSessionStage("HELLO", "duplicate");

    if (context && frame.session) {
      const stored = await getOutbox(`control:${convId}:ACK:${frame.nonce}`, context.vault);

      if (stored) await sendFrame(convId, JSON.parse(legacyOutboxCiphertext(stored)) as Frame, context);
    }

    console.warn("[sync] dropped replayed HELLO", { convId });

    return true;
  }

  if (seenHelloNonces.size > MAX_SEEN_HELLO_NONCES) {
    const oldestKey = seenHelloNonces.keys().next().value;

    if (oldestKey) seenHelloNonces.delete(oldestKey);
  }

  const peerCaps = normalizePeerCaps(frame.caps);
  const existing = peerContexts.get(ownerKey(convId, context)) ?? {};
  let responseContribution: SessionContribution | undefined;

  if (existing.deviceAuthorizationVersion === 2 || context && existing.kind === "friend") {
    if (!context || frame.controlVersion !== 2 || !frame.session || frame.session.authorization.deviceId !== frame.deviceId ||
      frame.session.authorization.identityPub !== frame.identityPub) throw new Error("FRESH_SESSION_REQUIRED");
    await assertFreshContribution(frame.session, context, convId);
    const latestPeerControl = freshPeerControlTimes.get(ownerKey(convId, context));

    if (latestPeerControl !== undefined && Number(frame.controlTs) < latestPeerControl) return false;
    const negotiationKey = ownerKey(convId, context);
    // A retained pre-restart HELLO may have no live offer; keep the smaller initiator live.

    if (getOrCreateDeviceId(context) < frame.deviceId && !freshOffers.has(negotiationKey) &&
      !freshCandidates.has(negotiationKey) && !freshSessions.get(negotiationKey)?.outbound) {
      await publishFreshHello(convId, existing, context);
      setReceiveCache(context, seenHelloNonces, replayKey, now);

      return true;
    }

    // Simultaneous offers use one authenticated initiator, never two crossing ratchets.
    if (freshOffers.has(ownerKey(convId, context)) && getOrCreateDeviceId(context) < frame.deviceId) {
      setReceiveCache(context, seenHelloNonces, replayKey, now);

      return true;
    }

    freshOffers.get(ownerKey(convId, context))?.privateKey.fill(0);
    freshOffers.delete(ownerKey(convId, context));
    deleteReceiveCache(context, pendingHelloNonces, sessionKey(convId, context));

    const own = existing.deviceAuthorizationVersion === 2 ? await getAuthorizedDevice(getOrCreateDeviceId(context), context)
      : await localFriendIdentity(context);

    if (!own) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
    const contribution = await createSessionContribution(own);

    try {
      const session = await agreeFreshSession(convId, frame.session, contribution.public, contribution.privateKey, false);
      await context.vault.assertMain();
      const key = ownerKey(convId, context);
      freshCandidates.get(key)?.key.fill(0);
      freshCandidates.set(key, session);
      countSessionStage("candidate", "success");
      freshPeerControlTimes.set(key, Math.max(freshPeerControlTimes.get(key) ?? 0, Number(frame.controlTs)));
      responseContribution = contribution.public;
    } finally { contribution.privateKey.fill(0); }
  }

  setReceiveCache(context, peerContexts, ownerKey(convId, context), {
    ...existing,
    identityPub: frame.identityPub,
    peerDeviceId: frame.deviceId,
    peerCaps,
    authenticatedCapsToken: pinnedPeerIdentity === frame.identityPub && frame.caps ? context?.owner.session.token : undefined,
  });
  logPeerCaps(convId, peerCaps);
  await flushDeferredRoleEvents(convId, context);
  // Legacy HELLO never authenticated its profile fields.
  const frameHash = context ? encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(frame))) : "";

  const ackPayload = {
    type: "ACK",
    identityPub: encodeBase64Url(await getIdentityPublicKey(context)),
    deviceId: getOrCreateDeviceId(context),
    nonce: frame.nonce,
    caps: LOCAL_CAPS,
    ...(responseContribution && context ? { session: responseContribution, offer: frame.session,
      keyConfirmation: await confirmFreshSession(freshCandidates.get(ownerKey(convId, context))!),
      ...(existing.deviceAuthorizationVersion === 2 ? { securityState: await handshakeSecurityState(convId, context) } : {}) } : {}),
  } as const;

  const sig = await signHandshake(ackPayload, context);
  await sendFrame(convId, { ...ackPayload, sig, ...(context ? { replyTo: frame.controlNonce } : {}) }, context);

  if (!existing.deviceAuthorizationVersion) await applyVerification(frame.identityPub, frame.deviceId, frame.controlVersion === 2 ? frame.profile : undefined, convId, context,
    context ? { eventId: frameHash, eventHash: frameHash, convId, lamport: 0, candidate: false } : undefined);

  if (!existing.deviceAuthorizationVersion) await resumeCertifiedStorageReceipts(convId, context);
  setReceiveCache(context, seenHelloNonces, replayKey, now);

  return true;
};

const handleAck = async (convId: string, frame: Extract<Frame, { type: "ACK" }>, context: ReceiveContext | undefined,
  retainNonce: () => Promise<void>) => {
  context?.vault.assertLocal();
  const key = sessionKey(convId, context);
  let pending = pendingHelloNonces.get(key);

  if (!pending && context && peerContexts.get(ownerKey(convId, context))?.kind !== "friend" && peerContexts.get(ownerKey(convId, context))?.deviceAuthorizationVersion !== 2 && frame.controlVersion === 2 && frame.replyTo) {
    const original = await getOutbox(`control:${convId}:HELLO:${frame.replyTo}`, context.vault);

    if (original?.ownerAccountId === context.owner.accountId && original.recipientIdentityPub === frame.identityPub) {
      const hello = JSON.parse(legacyOutboxCiphertext(original)) as Frame;

      if (hello.type === "HELLO" && hello.controlVersion === 2) pending = { nonce: hello.nonce, createdAt: Number(hello.controlTs) };
    }
  }

  if (
    !pending ||
    pending.nonce !== frame.nonce ||
    Date.now() - pending.createdAt > HANDSHAKE_NONCE_TTL_MS
  ) {
    countSessionReason(!pending ? "ACK_PENDING_MISSING" : pending.nonce !== frame.nonce ? "ACK_NONCE_MISMATCH" : "ACK_EXPIRED");
    console.warn("[sync] dropped unsolicited or stale ACK", { convId });

    return;
  }

  const pinnedPeerIdentity = peerContexts.get(ownerKey(convId, context))?.identityPub;

  if (pinnedPeerIdentity && pinnedPeerIdentity !== frame.identityPub) {
    countSessionReason("ACK_IDENTITY_MISMATCH");
    console.warn("[sync] dropped ACK with pinned identity mismatch", { convId });

    return;
  }

  const payload = {
    type: "ACK",
    identityPub: frame.identityPub,
    deviceId: frame.deviceId,
    nonce: frame.nonce,
    caps: frame.caps ?? null,
  };

  const legacyPayload = {
    type: "ACK",
    identityPub: frame.identityPub,
    deviceId: frame.deviceId,
    nonce: frame.nonce,
  };

  const ok = frame.controlVersion === 2 ? await verifyHandshake(controlPayload(frame), frame.sig, frame.identityPub) : await verifyHandshakeCompat(
    payload,
    legacyPayload,
    frame.sig,
    frame.identityPub,
    Boolean(frame.caps)
  );

  if (!ok) {
    console.warn("[sync] invalid ACK signature", { convId });
    countSessionReason("ACK_SIGNATURE_INVALID");

    return;
  }

  const peerCaps = normalizePeerCaps(frame.caps);
  const existing = peerContexts.get(ownerKey(convId, context)) ?? {};

  if (existing.deviceAuthorizationVersion === 2 || context && existing.kind === "friend") {
    const offer = freshOffers.get(ownerKey(convId, context));

    if (!context || frame.controlVersion !== 2 || !offer || !frame.session || !frame.offer ||
      frame.session.authorization.deviceId !== frame.deviceId || frame.session.authorization.identityPub !== frame.identityPub ||
      encodeBase64Url(canonicalBytes(offer.public)) !== encodeBase64Url(canonicalBytes(frame.offer))) {
      countSessionReason("ACK_OFFER_MISMATCH");

      return false;
    }

    await assertFreshContribution(frame.session, context, convId);
    await assertFreshContribution(frame.offer, context, convId);
    const session = await agreeFreshSession(convId, offer.public, frame.session, offer.privateKey, true);

    if (!frame.keyConfirmation || !await verifyFreshSessionConfirmation(session, frame.keyConfirmation)) {
      session.key.fill(0);
      countSessionReason("ACK_CONFIRMATION_INVALID");

      return false;
    }

    if (session.initiator.kind === "FRIEND_BOUND" && !matchesFreshSession(session, await localFriendIdentity(context),
      await authenticatedFriendIdentity(convId, context))) return { status: "FAILED", code: "FRIEND_AUTHENTICATION_REQUIRED" } as const;
    await context.vault.assertMain();
    await persistFreshSession(convId, session, context, retainNonce);
    const sessionKey = ownerKey(convId, context), previous = freshSessions.get(sessionKey);
    previous?.outbound?.key.fill(0); previous?.inbound?.key.fill(0);
    freshSessions.set(sessionKey, { outbound: session, inbound: session });
    freshPeerControlTimes.set(sessionKey, Math.max(freshPeerControlTimes.get(sessionKey) ?? 0, Number(frame.controlTs)));
    await sendFrame(convId, { type: "SESSION_READY", sessionId: session.id, keyConfirmation: await confirmFreshSession(session), replyTo: frame.controlNonce }, context);
    offer.privateKey.fill(0);
  } else await retainNonce();
  setReceiveCache(context, peerContexts, ownerKey(convId, context), {
    ...existing,
    identityPub: frame.identityPub,
    peerDeviceId: frame.deviceId,
    peerCaps,
    authenticatedCapsToken: pinnedPeerIdentity === frame.identityPub && frame.caps ? context?.owner.session.token : undefined,
  });

  // Publish readiness only after the authenticated capabilities are available to waiting sends.
  if (context && (existing.deviceAuthorizationVersion === 2 || existing.kind === "friend")) {
    freshOffers.delete(ownerKey(convId, context));
    resumeFreshSessionOutbox(convId, context);
    scheduleHistoryCatchup(convId, context);
  }

  logPeerCaps(convId, peerCaps);
  await flushDeferredRoleEvents(convId, context);
  const frameHash = context ? encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(frame))) : "";

  if (!existing.deviceAuthorizationVersion) await applyVerification(frame.identityPub, frame.deviceId, undefined, convId, context,
    context ? { eventId: frameHash, eventHash: frameHash, convId, lamport: 0, candidate: false } : undefined);

  if (!existing.deviceAuthorizationVersion) await resumeCertifiedStorageReceipts(convId, context);
  deleteReceiveCache(context, pendingHelloNonces, key);

  return true;
};

const handleIncomingNow = async (convId: string, bytes: Uint8Array, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const frame = tryParseFrame(bytes);

  if (!frame) return;

  if (context && frame.deviceDelivery && (frame.type === "HELLO" || frame.type === "ACK")) {
    context = await reconcileHandshakeState(frame, context);
  }

  if (context && peerContexts.get(ownerKey(convId, context))?.kind === "device" && await getAccountRootIdentity(context)) {
    context = await captureDeviceRegistryContext(context);
  }

  if (!await isDeviceSyncAllowed(convId, "incoming-control", context)) return { status: "FAILED", code: "DEVICE_AUTHORIZATION_REQUIRED" } as const;
  countSessionStage("authority", "success");

  if (!context && typeof window !== "undefined" && window.nkc?.activateAccountSession) return { status: "FAILED", code: "OWNER_REQUIRED" } as const;

  if (context && (frame.controlVersion === 2 || (frame.type !== "HELLO" && frame.type !== "ACK"))) {
    const pinned = peerContexts.get(ownerKey(convId, context));

    if (frame.controlVersion !== 2 || typeof frame.identityPub !== "string" || frame.identityPub !== pinned?.identityPub ||
      typeof frame.deviceId !== "string" || typeof frame.sig !== "string" ||
      typeof frame.controlNonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(frame.controlNonce) ||
      !Number.isFinite(frame.controlTs) || Math.abs(Date.now() - Number(frame.controlTs)) > HANDSHAKE_NONCE_TTL_MS ||
      frame.recipientIdentityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
      (frame.type !== "HELLO" && frame.type !== "ACK" && frame.deviceId !== pinned?.peerDeviceId) ||
      !await verifyHandshake(controlPayload(frame), frame.sig, frame.identityPub)) {
      countSessionStage("authority", "rejected");

      if (!Number.isFinite(frame.controlTs) || Math.abs(Date.now() - Number(frame.controlTs)) > HANDSHAKE_NONCE_TTL_MS)
        countSessionStage("freshness", "rejected");

      return { status: "FAILED", code: "CONTROL_AUTHENTICATION_REJECTED" } as const;
    }

    await context.vault.assertMain();
  }

  if (context && frame.type === "SYNC_REQ" && !getCertifiedSessionState(convId, context).ready) {
    countSessionStage("ready", "deferred");

    return { status: "OWNED_DEFERRED", accountId: context.owner.accountId, eventId: frame.controlNonce ?? "",
      recoveryOwner: { mechanism: "existing-inbox", reference: context.owner.operationId } } as const;
  }

  if (context && (frame.type === "SYNC_REQ" || frame.type === "SYNC_RES")) {
    const validVector = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value).every(([key, lamport]) => key.length > 0 && key.length <= 128 && Number.isSafeInteger(lamport) && Number(lamport) >= 0);

    if (!["conv", "contacts", "conversations", "global"].includes(frame.scope) ||
      (frame.convId !== undefined && frame.convId !== convId) ||
      !validVector(frame.type === "SYNC_REQ" ? frame.since : frame.next) ||
      (frame.scope !== "conv" && !await isApprovedLinkedDevicePeer(convId, "control_scope", context)) ||
      (frame.type === "SYNC_RES" && (!Array.isArray(frame.events) || (frame.flow &&
        (typeof frame.flow.sessionId !== "string" || !frame.flow.sessionId || frame.flow.sessionId.length > 128 || !Number.isSafeInteger(frame.flow.chunkIndex) ||
          !Number.isSafeInteger(frame.flow.totalChunks) || frame.flow.chunkIndex < 0 || frame.flow.totalChunks < 1 || frame.flow.totalChunks > 2048 ||
          frame.flow.chunkIndex >= frame.flow.totalChunks || frame.flow.final !== (frame.flow.chunkIndex === frame.flow.totalChunks - 1)))))) {
      return { status: "FAILED", code: "CONTROL_SCOPE_REJECTED" } as const;
    }
  }

  if (context && frame.type === "SYNC_RES" && frame.inventory !== undefined && toBytes(frame).byteLength > MAX_SYNC_CHUNK_BYTES)
    return { status: "FAILED", code: "HISTORY_INVENTORY_LIMIT" } as const;
  const controlHash = context ? encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(frame))) : "";
  const controlKey = `friend_control_v1:${controlHash}`;

  // A completed HELLO from a previous process cannot replace a fresh negotiation after restart.
  if (context && frame.type === "HELLO" && frame.session &&
    (await context.vault.db.meta.get(controlKey))?.value === controlHash &&
    !seenHelloNonces.has(sessionKey(`HELLO:${frame.identityPub}:${frame.nonce}`, context))) {
    return { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const;
  }

  let target: Awaited<ReturnType<typeof getOutbox>>;

  if (context && (frame.type === "ACK" || frame.type === "SESSION_READY" || frame.type === "SYNC_FLOW_ACK") && !frame.replyTo)
    return { status: "FAILED", code: "CONTROL_REPLY_REJECTED" } as const;

  if (context && frame.replyTo !== undefined) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(frame.replyTo)) return { status: "FAILED", code: "CONTROL_REPLY_REJECTED" } as const;
    const targetType = frame.type === "ACK" ? "HELLO" : frame.type === "SESSION_READY" ? "ACK" : frame.type === "SYNC_RES" ? "SYNC_REQ" : frame.type === "SYNC_FLOW_ACK" ? "SYNC_RES" : null;

    if (!targetType) return { status: "FAILED", code: "CONTROL_REPLY_REJECTED" } as const;
    target = await getOutbox(`control:${convId}:${targetType}:${frame.replyTo}`, context.vault);

    if (!target || target.ownerAccountId !== context.owner.accountId || target.convId !== convId ||
      target.recipientIdentityPub !== frame.identityPub) return { status: "FAILED", code: "CONTROL_REPLY_REJECTED" } as const;
    const sent = JSON.parse(legacyOutboxCiphertext(target)) as Frame;

    if (sent.type !== targetType || sent.controlNonce !== frame.replyTo ||
      (frame.type === "ACK" && sent.type === "HELLO" && frame.nonce !== sent.nonce) ||
      (frame.type === "SYNC_RES" && sent.type === "SYNC_REQ" && frame.scope !== sent.scope) ||
      (frame.type === "SYNC_FLOW_ACK" && sent.type === "SYNC_RES" && (!sent.flow ||
        frame.sessionId !== sent.flow.sessionId || frame.chunkIndex !== sent.flow.chunkIndex || frame.receivedEvents !== sent.events.length))) {
      return { status: "FAILED", code: "CONTROL_REPLY_REJECTED" } as const;
    }
  }

  const retainNonce = async () => {
    if (!context || frame.controlVersion !== 2) return;
    // ACK admission follows session validation but precedes its first durable effect.
    const nonceKey = `control_nonce_v2:${frame.identityPub}:${frame.controlNonce}`;
    await writeVault(context.vault, [context.vault.db.meta], async () => {
      const previous = await context.vault.db.meta.get(nonceKey);

      if (previous && JSON.parse(previous.value).hash !== controlHash) throw new Error("CONTROL_NONCE_CONFLICT");

      if (!previous) await context.vault.db.meta.put({ key: nonceKey,
        value: JSON.stringify({ hash: controlHash, expiresAt: Number(frame.controlTs) + HANDSHAKE_NONCE_TTL_MS }) });

      // ponytail: bounded cleanup of existing metadata; no separate replay store or queue.
      for (const row of await context.vault.db.meta.where("key").startsWith("control_nonce_v2:").limit(100).toArray()) {
        if (JSON.parse(row.value).expiresAt < Date.now()) await context.vault.db.meta.delete(row.key);
      }
    });
  };

  if (frame.type !== "ACK" && frame.type !== "SESSION_READY") await retainNonce();

  const duplicate = context && frame.controlVersion === 2 && frame.type !== "HELLO" &&
    (await context.vault.db.meta.get(controlKey))?.value === controlHash;

  if ((frame.type === "ACK" || frame.type === "SESSION_READY") && duplicate) await retainNonce();

  if (context && frame.type === "SYNC_RES") {
    const sent = target ? JSON.parse(legacyOutboxCiphertext(target)) as Frame : undefined;

    if (sent?.type === "SYNC_REQ" && sent.inventoryVersion === 1 || frame.inventory !== undefined) {
      const author = frame.deviceDelivery?.author;

      if (sent?.type !== "SYNC_REQ" || sent.inventoryVersion !== 1 || !sent.history || !frame.inventory || !author ||
        !frame.flow || frame.scope !== "global" || frame.flow.chunkIndex !== frame.inventory.page ||
        frame.flow.totalChunks !== frame.inventory.totalPages || frame.flow.sessionId !== frame.inventory.snapshotId ||
        sent.resumeInventory && frame.inventory.snapshotId !== sent.resumeInventory.snapshotId ||
        !await isApprovedLinkedDevicePeer(convId, "history-inventory", context)) return { status: "FAILED", code: "HISTORY_INVENTORY_REQUIRED" } as const;

      const binding: HistoryBinding = { accountIdentity: await getAccountRootIdentity(context) ?? "",
        requesterDeviceId: getOrCreateDeviceId(context), sourceDeviceId: author.deviceId, sourceIdentityPub: author.identityPub,
        sourceEpoch: author.epoch, requestId: sent.resumeInventory?.requestId ?? sent.controlNonce!, scope: "global", history: sent.history };

      await retainHistoryInventory(convId, frame.inventory, binding, frame.events, context, author);
    }
  }

  const flow = context && frame.type === "SYNC_RES" ? frame.flow : undefined;
  const flowKey = flow ? `sync_flow_receive_v2:${convId}:${frame.identityPub}:${flow.sessionId}` : undefined;

  if (context && flow && flowKey && !duplicate) {
    const record = await context.vault.db.meta.get(flowKey);
    const progress = record ? JSON.parse(record.value) as { next: number; total: number } : { next: 0, total: flow.totalChunks };

    const resume = frame.type === "SYNC_RES" && frame.inventory && target && (JSON.parse(legacyOutboxCiphertext(target)) as SyncReqFrame).resumeInventory;

    if (progress.total !== flow.totalChunks || flow.chunkIndex < progress.next && !resume) return { status: "FAILED", code: "FLOW_SEQUENCE_CONFLICT" } as const;

    if (flow.chunkIndex > progress.next) return { status: "OWNED_DEFERRED", accountId: context.owner.accountId,
      eventId: controlHash, recoveryOwner: { mechanism: "existing-inbox", reference: context.owner.operationId } } as const;
  }

  const dispatch = async () => {
    if (frame.type === "SESSION_READY") {
      const current = freshSessions.get(ownerKey(convId, context));
      const candidate = freshCandidates.get(ownerKey(convId, context));
      const admitted = !candidate && context && await context.vault.db.meta.get(`control_nonce_v2:${frame.identityPub}:${frame.controlNonce}`);

      // Completion can fail after RAM promotion; resume only the exact previously admitted frame.
      const session = candidate ?? (current?.inbound === current?.outbound && admitted && JSON.parse(admitted.value).hash === controlHash
        ? current?.inbound : undefined);

      if (!context || !target || !session || session.id !== frame.sessionId || !await verifyFreshSessionConfirmation(session, frame.keyConfirmation)) {
        return { status: "FAILED", code: "FRESH_SESSION_REQUIRED" } as const;
      }

      if (session.initiator.kind === "FRIEND_BOUND" && !matchesFreshSession(session, await localFriendIdentity(context),
        await authenticatedFriendIdentity(convId, context))) return { status: "FAILED", code: "FRIEND_AUTHENTICATION_REQUIRED" } as const;
      await context.vault.assertMain();
      await persistFreshSession(convId, session, context, retainNonce);
      const key = ownerKey(convId, context), old = freshSessions.get(key);

      if (old?.inbound !== session) old?.inbound?.key.fill(0);

      if (old?.outbound !== session) old?.outbound?.key.fill(0);
      freshSessions.set(key, { inbound: session, outbound: session });
      freshCandidates.delete(key);
      countSessionStage("candidate-promote", "success");
      countSessionStage("ready", "success");
      resumeFreshSessionOutbox(convId, context);
      scheduleHistoryCatchup(convId, context);

      return { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const;
    }

    if (frame.type === "HELLO") {
      const applied = await handleHello(convId, frame, context);

      return context ? applied ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const
        : { status: "FAILED", code: "HELLO_REJECTED" } as const : undefined;
    }

    if (frame.type === "ACK") {
      const applied = await handleAck(convId, frame, context, retainNonce);

      if (!applied && context && target) {
        const peer = peerContexts.get(ownerKey(convId, context)), state = getCertifiedSessionState(convId, context);

        // The authenticated owned reply cannot restore a prior process's private offer; keep rejecting it.
        if (peer && (peer.deviceAuthorizationVersion === 2 || peer.kind === "friend") &&
          !state.ready && !state.offer && !state.candidate) {
          await retainNonce();
          await publishFreshHello(convId, peer, context);
        }
      }

      return context ? applied ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const
        : { status: "FAILED", code: "ACK_REJECTED" } as const : undefined;
    }

    if (frame.type === "SYNC_REQ") {
      const applied = await handleSyncReq(convId, frame, context);

      return context ? applied ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const
        : { status: "FAILED", code: "SYNC_REQ_REJECTED" } as const : undefined;
    }

    if (frame.type === "SYNC_RES") {
      return handleSyncRes(convId, frame, firstMessageMeasurement.packetContext(bytes), context);
    }

    if (frame.type === "SYNC_FLOW_ACK") {
      // The authenticated immutable Outbox binding survives restart or a rolled-back marker.
      const applied = context ? Boolean(target) : await handleSyncFlowAck(convId, frame, context);

      return context ? applied ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const
        : { status: "FAILED", code: "FLOW_ACK_REJECTED" } as const : undefined;
    }
  };

  const completion = duplicate && context ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId } as const : await dispatch();

  if (duplicate) countSessionStage("control", "duplicate");

  if (context && completion && receiveSucceeded(completion)) {
    await writeVault(context.vault, [context.vault.db.meta, context.vault.db.outbox], async () => {
      if (flow && flowKey && !duplicate) {
        const record = await context.vault.db.meta.get(flowKey);
        const progress = record ? JSON.parse(record.value) as { next: number; total: number } : { next: 0, total: flow.totalChunks };

        const resume = frame.type === "SYNC_RES" && frame.inventory && target && (JSON.parse(legacyOutboxCiphertext(target)) as SyncReqFrame).resumeInventory;

        if (progress.total !== flow.totalChunks || progress.next !== flow.chunkIndex && !(resume && flow.chunkIndex < progress.next)) throw new Error("FLOW_SEQUENCE_CONFLICT");
        await context.vault.db.meta.put({ key: flowKey, value: JSON.stringify({ next: Math.max(progress.next, flow.chunkIndex + 1),
            total: flow.totalChunks, expiresAt: Number(frame.controlTs) + HANDSHAKE_NONCE_TTL_MS }) });

        // ponytail: bounded cleanup in existing meta, never a pending chunk queue.
        for (const row of await context.vault.db.meta.where("key").startsWith("sync_flow_receive_v2:").limit(100).toArray()) {
          if (JSON.parse(row.value).expiresAt < Date.now()) await context.vault.db.meta.delete(row.key);
        }
      }

      if (target && (frame.type !== "SYNC_RES" || !frame.flow || frame.flow.final)) {
        const current = await context.vault.db.outbox.get(target.id);

        if (!current || current.ciphertext !== target.ciphertext || current.ownerAccountId !== context.owner.accountId ||
          current.recipientIdentityPub !== frame.identityPub) throw new Error("CONTROL_REPLY_CONFLICT");
        await context.vault.db.outbox.update(target.id, { status: "acked", ackDeadlineMs: undefined, inFlightAtMs: undefined, lastError: undefined, nativeRetryStopped: false });
      }

      await context.vault.db.meta.put({ key: controlKey, value: controlHash });
    });
    countSessionStage("commit", "success");

    if (frame.type === "SYNC_FLOW_ACK") await handleSyncFlowAck(convId, frame, context);
  }

  return completion;
};

const handleIncoming = async (convId: string, bytes: Uint8Array, context?: ReceiveContext) => {
  try {
    const frame = tryParseFrame(bytes);

    if (frame?.type === "HELLO" || frame?.type === "ACK" || frame?.type === "SESSION_READY") countSessionStage(frame.type, "input");

    const observe = (result: Awaited<ReturnType<typeof handleIncomingNow>>) => {
      const outcome = result?.status === "CONTROL_APPLIED" ? "success" : result?.status === "OWNED_DEFERRED" ? "deferred" : "rejected";
      countSessionStage("control", outcome);

      if (result?.status === "FAILED") countSessionReason(result.code);

      if (result?.status === "FAILED" && result.code === "CONTROL_REPLY_REJECTED") countSessionStage("control", "reply");

      return result;
    };

    if (context && frame && ["HELLO", "ACK", "SESSION_READY"].includes(frame.type)) {
      return observe(await withFriendControlLock(`session:${sessionKey(convId, context)}`, () => handleIncomingNow(convId, bytes, context)));
    }

    return observe(await handleIncomingNow(convId, bytes, context));
  } catch (error) {
    countSessionStage("control", "error");

    if (error instanceof Error) countSessionReason(error.message);

    if (!context || !(error instanceof Error) || error.message !== "DEVICE_AUTHORITY_CHANGED") throw error;
    const current = await captureLocalOperationContext();

    if (!current || current.vault.db !== context.vault.db || current.owner.accountId !== context.owner.accountId ||
      current.owner.session.token !== context.owner.session.token) throw error;
    await current.vault.assertMain();

    // No success/cursor/ACK: retry the retained authenticated packet under current registry authority.
    return { status: "OWNED_DEFERRED", accountId: current.owner.accountId, eventId: "",
      recoveryOwner: { mechanism: "existing-inbox", reference: context.owner.operationId } } as const;
  }
};

export const handleIncomingSyncFrame = handleIncoming;

const reconcileHandshakeState = async (frame: Extract<Frame, { type: "HELLO" | "ACK" }>, context: ReceiveContext) => {
  const author = frame.deviceDelivery?.author;

  if (!author || frame.controlVersion !== 2 || frame.deviceId !== author.deviceId || frame.identityPub !== author.identityPub ||
    frame.deviceDelivery?.recipientDeviceId !== getOrCreateDeviceId(context) ||
    frame.recipientIdentityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
    frame.convId !== deviceChannelIdentity(getOrCreateDeviceId(context), author.deviceId) ||
    !Number.isFinite(frame.controlTs) || Math.abs(Date.now() - Number(frame.controlTs)) > HANDSHAKE_NONCE_TTL_MS ||
    !await verifyDeviceAuthorization(author, author.accountRootIdentityPub) ||
    !await verifyHandshake(controlPayload(frame), frame.sig, frame.identityPub) || !Array.isArray(frame.securityState)) {
    throw new Error("CONTROL_AUTHENTICATION_REJECTED");
  }

  const ownRoot = await getAccountRootIdentity(context);

  if (frame.securityState.length > 64 || frame.securityState.some(row => !row ||
    ![ownRoot, author.accountRootIdentityPub].includes(row.accountRootIdentityPub))) throw new Error("DEVICE_AUTHORIZATION_INVALID");
  let current = context;

  for (const root of [...new Set(frame.securityState.map(row => row.accountRootIdentityPub))]) {
    current = await reconcileDeviceAuthorizations(frame.securityState.filter(row => row.accountRootIdentityPub === root), root, current);
  }

  return current;
};

/** Root dispatcher resolves a peer within the already resolved local recipient vault. */
export const ingestIncomingProtocolText = async (text: string, replyRoute: IncomingReplyRoute | undefined, context: ReceiveContext) => {
  await context.vault.assertMain();
  const frame = tryParseFrame(textEncoder.encode(text));

  if (!frame || !["HELLO", "ACK", "SESSION_READY", "SYNC_REQ", "SYNC_RES", "SYNC_FLOW_ACK"].includes(frame.type)) return undefined;

  if (frame.deviceDelivery) {
    const delivery = frame.deviceDelivery;

    if (frame.controlVersion !== 2 || delivery.v !== 2 || delivery.recipientDeviceId !== getOrCreateDeviceId(context) ||
      delivery.author?.deviceId !== frame.deviceId || delivery.author.identityPub !== frame.identityPub ||
      typeof frame.convId !== "string" || typeof frame.sig !== "string" ||
      !await verifyHandshake(controlPayload(frame), frame.sig, delivery.author.identityPub)) {
      return { status: "FAILED", code: "CONTROL_AUTHENTICATION_REJECTED" } as const;
    }

    try {
      if (frame.type === "HELLO" || frame.type === "ACK") context = await reconcileHandshakeState(frame, context);
      context = await bindCertifiedEndpoint(frame.convId, delivery.author, context);
    }
    catch (error) {
      const code = error instanceof Error && ["ACCOUNT_ROOT_UNCONFIRMED", "DEVICE_AUTHORITY_CHANGED", "SECURITY_STATE_CONFLICT",
        "DEVICE_AUTHORIZATION_CONFLICT", "DEVICE_AUTHORIZATION_INVALID", "ROLLBACK_HINT_INVALID", "CONTROL_AUTHENTICATION_REJECTED"].includes(error.message)
        ? error.message : "DEVICE_AUTHORIZATION_REQUIRED";

      return { status: "FAILED", code } as const;
    }

    return handleIncoming(frame.convId, textEncoder.encode(text), context);
  }

  const profiles = await listProfiles(context.vault);

  const peers = profiles.filter(profile => profile.kind === "friend" && profile.friendStatus !== "blocked" &&
    profile.friendStatus !== "deleted" && profile.verification?.status !== "key_changed" && (
      (frame.type === "HELLO" || frame.type === "ACK" || frame.controlVersion === 2) ? profile.identityPub === frame.identityPub :
        Boolean(replyRoute?.toDeviceId && (profile.primaryDeviceId === replyRoute.toDeviceId ||
          profile.routingHints?.deviceId === replyRoute.toDeviceId))));

  const conversations = (await listConversations(context.vault)).filter(conv => conv.type !== "group" &&
    (frame.convId === undefined || conv.id === frame.convId) &&
    peers.some(peer => conv.participants.includes(peer.id)));

  if (conversations.length !== 1) return { status: "FAILED", code: "CONTROL_PEER_BINDING_UNAVAILABLE" } as const;
  const conv = conversations[0];

  if (!await ensurePeerContextFromConversation(conv.id, context)) return { status: "FAILED", code: "CONTROL_PEER_BINDING_UNAVAILABLE" } as const;

  return handleIncoming(conv.id, textEncoder.encode(text), context);
};

export const setSyncTransportOverride = (transport: SyncTransportOverride | null) => {
  syncTransportOverride = transport;

  return () => {
    if (syncTransportOverride === transport) {
      syncTransportOverride = null;
    }
  };
};

export const connectConversation = async (convId: string, peerHint: PeerContext, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();

  return withFriendControlLock(`session:${sessionKey(convId, context)}`, () => connectConversationNow(convId, peerHint, context));
};

const connectConversationNow = async (convId: string, peerHint: PeerContext, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  await context?.vault.assertMain();

  if (context) await assertRatchetNotQuarantined(convId, context);

  if (context && peerHint.deviceAuthorizationVersion !== 2 && await getAccountRootIdentity(context)) {
    context = await captureDeviceRegistryContext(context);

    if (!peerHint.identityPub) throw new Error("ACCOUNT_IDENTITY_INVALID");

    const targets = Object.values(await getAuthorizedDeviceRegistry(context, peerHint.identityPub))
      .filter(target => target.kind === "DEVICE_ADDED" && target.deviceId !== getOrCreateDeviceId(context));

    if (!targets.length && (peerHint.kind === "device" || Object.keys(await getAuthorizedDeviceRegistry(context, peerHint.identityPub)).length))
      throw new Error("RECIPIENT_DEVICES_UNKNOWN");

    if (targets.length) await disconnectConversation(convId);

    for (const target of targets) {
      if (!target.route) throw new Error("DEVICE_ROUTE_UNAVAILABLE");
      await connectConversation(deviceChannelIdentity(getOrCreateDeviceId(context), target.deviceId), {
        kind: target.accountRootIdentityPub === await getAccountRootIdentity(context) ? "device" : "friend",
        deviceAuthorizationVersion: 2, accountRootIdentity: target.accountRootIdentityPub,
        identityPub: target.identityPub, dhPub: target.dhPub, peerDeviceId: target.deviceId, friendKeyId: target.deviceId,
        onionAddr: target.route.onionAddr, inboxWriteToken: target.route.inboxWriteToken }, context);
    }

    if (targets.length) return;
  }

  const existing = peerContexts.get(ownerKey(convId, context));

  if (context && peerHint.deviceAuthorizationVersion !== 2 && peerHint.kind !== "device") {
    const friend = await authenticatedFriendIdentity(convId, context, peerHint);
    peerHint = { ...peerHint, kind: "friend", peerDeviceId: friend.deviceId };
  }

  const negotiationKey = ownerKey(convId, context);
  const pendingSince = freshCandidates.get(negotiationKey)?.createdAt ?? pendingHelloNonces.get(sessionKey(convId, context))?.createdAt;

  const reuseNegotiation = Boolean(context && (peerHint.deviceAuthorizationVersion === 2 || peerHint.kind === "friend") && existing &&
    existing.identityPub === peerHint.identityPub && existing.dhPub === peerHint.dhPub &&
    existing.accountRootIdentity === peerHint.accountRootIdentity && existing.peerDeviceId === peerHint.peerDeviceId &&
    (freshOffers.has(negotiationKey) || freshCandidates.has(negotiationKey)) && pendingSince && Date.now() - pendingSince < 15_000);

  const reuseCapabilities = Boolean(context && existing?.authenticatedCapsToken === context.owner.session.token && existing.peerCaps &&
    freshSessions.get(ownerKey(convId, context))?.outbound &&
    existing.identityPub === peerHint.identityPub && existing.dhPub === peerHint.dhPub &&
    existing.friendKeyId === peerHint.friendKeyId && existing.peerDeviceId === peerHint.peerDeviceId &&
    (peerHint.kind === undefined || existing.kind === peerHint.kind));

  if ((reuseCapabilities || reuseNegotiation) && context && existing) {
    setReceiveCache(context, peerContexts, ownerKey(convId, context), { ...existing, ...peerHint,
      peerCaps: existing.peerCaps, authenticatedCapsToken: existing.authenticatedCapsToken });
  } else setReceiveCache(context, peerContexts, ownerKey(convId, context), { ...peerHint, authenticatedCapsToken: undefined });
  const allowed = await isDeviceSyncAllowed(convId, "connect", context);

  if (!allowed) return;
  const subscriptionKey = ownerKey(convId, context);
  const subscriptionAccount = context?.owner.accountId ?? getActiveAccountId();

  if (!convSubscriptions.has(subscriptionKey)) {
    const unsubscribe = onConversationMessage(convId, (bytes, receiveContext) => {
      if (receiveContext && receiveContext.owner.accountId !== subscriptionAccount) return { status: "FAILED", code: "OWNER_SUBSCRIPTION_MISMATCH" };

      return handleIncoming(convId, bytes, receiveContext);
    });

    setReceiveCache(context, convSubscriptions, subscriptionKey, unsubscribe);
  }

  countSessionStage("transport", "input");
  await connectTransport(convId, peerHint);
  countSessionStage("transport", "success");
  context?.vault.assertLocal();

  if (reuseCapabilities || reuseNegotiation) return;

  countSessionStage("hello-publish", "input");
  await publishFreshHello(convId, peerHint, context);
  countSessionStage("hello-publish", "success");

  if (peerHint.deviceAuthorizationVersion !== 2) {
    countSessionStage("sync-conversation", "input");
    await syncConversation(convId, context);
    countSessionStage("sync-conversation", "success");
    countSessionStage("sync-global", "input");
    await syncGlobal(convId, context);
    countSessionStage("sync-global", "success");
  }
};

const publishFreshHello = async (convId: string, peerHint: PeerContext, context?: ReceiveContext) => {
  await context?.vault.assertMain();

  if (context) await assertRatchetNotQuarantined(convId, context);

  const subscriptionKey = ownerKey(convId, context);

  if (freshCandidates.has(subscriptionKey)) countSessionStage("candidate-replace", "rejected");
  freshCandidates.get(subscriptionKey)?.key.fill(0); freshCandidates.delete(subscriptionKey);
  const identityPub = await getIdentityPublicKey(context);
  let offer: Awaited<ReturnType<typeof createSessionContribution>> | undefined;
  let hello: Extract<Frame, { type: "HELLO" }> | undefined;

  try {
    if (peerHint.deviceAuthorizationVersion === 2 || peerHint.kind === "friend") {
      if (!context) throw new Error("OWNER_REQUIRED");

      if (peerHint.deviceAuthorizationVersion !== 2) await authenticatedFriendIdentity(convId, context);
      const own = peerHint.deviceAuthorizationVersion === 2 ? await getAuthorizedDevice(getOrCreateDeviceId(context), context) : await localFriendIdentity(context);

      if (!own) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
      offer = await createSessionContribution(own);
      freshOffers.get(ownerKey(convId, context))?.privateKey.fill(0);
      freshOffers.set(ownerKey(convId, context), offer);
      countSessionStage("offer", "success");
    }

    const helloPayload = {
      type: "HELLO",
      deviceId: getOrCreateDeviceId(context),
      identityPub: encodeBase64Url(identityPub),
      nonce: createNonce(),
      caps: LOCAL_CAPS,
      ...(offer && context ? { session: offer.public, ...(peerHint.deviceAuthorizationVersion === 2 ? { securityState: await handshakeSecurityState(convId, context) } : {}) } : {}),
    } as const;

    setReceiveCache(context, pendingHelloNonces, sessionKey(convId, context), { nonce: helloPayload.nonce, createdAt: Date.now() });
    const sig = await signHandshake(helloPayload, context);
    const localUserId = await resolveLocalUserId(context);
    let profile: HelloFrame["profile"] | undefined;

    if (localUserId) {
      const profiles = await listProfiles(context?.vault);
      const me = profiles.find((item) => item.id === localUserId) || null;

      if (me) {
        profile = { displayName: me.displayName, status: me.status, avatarRef: me.avatarRef };
      }
    }

    hello = { ...helloPayload, sig, profile };
    await sendFrame(convId, hello, context);
  } catch (error) {
    if (offer && freshOffers.get(subscriptionKey) === offer) {
      let retained = false;

      try {
        retained = Boolean(context && hello?.controlNonce &&
          await getOutbox(`control:${convId}:HELLO:${hello.controlNonce}`, context.vault));
      } finally {
        // A failed unpublished offer cannot win the simultaneous-HELLO tie.
        if (!retained && freshOffers.get(subscriptionKey) === offer) {
          offer.privateKey.fill(0);
          freshOffers.delete(subscriptionKey);
          deleteReceiveCache(context, pendingHelloNonces, sessionKey(convId, context));
        }
      }
    }

    throw error;
  }

};

export const disconnectConversation = async (convId: string) => {
  const subscriptionKey = ownerKey(convId);
  peerContexts.delete(subscriptionKey);
  freshOffers.get(subscriptionKey)?.privateKey.fill(0);
  freshOffers.delete(subscriptionKey);
  freshSessions.get(subscriptionKey)?.outbound?.key.fill(0);
  freshSessions.get(subscriptionKey)?.inbound?.key.fill(0);
  freshSessions.delete(subscriptionKey);
  freshCandidates.get(subscriptionKey)?.key.fill(0);
  freshCandidates.delete(subscriptionKey);

  for (const key of pendingHelloNonces.keys()) if (key.startsWith(`${subscriptionKey}:`)) pendingHelloNonces.delete(key);
  const unsubscribe = convSubscriptions.get(subscriptionKey);

  if (unsubscribe) {
    unsubscribe();
    convSubscriptions.delete(subscriptionKey);
  }

  await disconnectTransport(convId);
};

export const syncConversation = async (convId: string, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  const allowed = await isDeviceSyncAllowed(convId, "sync_conversation", context);

  if (!allowed) return;
  const since = getSinceMap(convId, context);

  const frame: SyncReqFrame = {
    type: "SYNC_REQ",
    scope: "conv",
    convId,
    since,
  };

  await sendFrame(convId, frame, context);
};

export const syncGlobal = async (convId: string, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  const allowed = await isApprovedLinkedDevicePeer(convId, "sync_global", context);

  if (!allowed) return;
  const since = getSinceMap(globalLogId(convId), context);

  const frame: SyncReqFrame = {
    type: "SYNC_REQ",
    scope: "global",
    convId,
    since,
  };

  await sendFrame(convId, frame, context);
};

/** Initial policy is explicit; subsequent calls retain its cutoff. */
export const syncApprovedDeviceHistory = async (deviceId: string,
  policy?: "ALL" | "LAST_30_DAYS" | "NEW_ONLY", captured?: ReceiveContext, fromSourceDeviceId?: string) => {
  captured ??= await captureLocalOperationContext();

  if (!captured) throw new Error("OWNER_REQUIRED");
  const context = captured;

  return withFriendControlLock(`history-request:${ownerKey(deviceId, context)}`,
    () => syncApprovedDeviceHistoryNow(deviceId, policy, context, fromSourceDeviceId));
};

const pendingHistoryRequest = (channel: string, context: ReceiveContext, requestId?: string) =>
  context.vault.db.outbox.where("convId").equals(channel).filter(row => {
    if (row.ownerAccountId !== context.owner.accountId || row.expiresAtMs <= Date.now() ||
      row.status !== "pending" && row.status !== "in_flight") return false;
    // SAFETY: local signed control Outbox; ordinary envelope records have no matching discriminator.
    const frame = JSON.parse(legacyOutboxCiphertext(row)) as Frame;

    return frame.type === "SYNC_REQ" && frame.scope === "global" && frame.inventoryVersion === 1 && Boolean(frame.history) &&
      frame.resumeInventory?.requestId === requestId &&
      Number(frame.controlTs) >= (freshSessions.get(ownerKey(channel, context))?.outbound?.createdAt ?? Infinity) &&
      Number(frame.controlTs) + HANDSHAKE_NONCE_TTL_MS > Date.now();
  }).first();

const syncApprovedDeviceHistoryNow = async (deviceId: string,
  policy: "ALL" | "LAST_30_DAYS" | "NEW_ONLY" | undefined, captured: ReceiveContext, fromSourceDeviceId?: string) => {
  const context = await captureDeviceRegistryContext(captured);
  const target = await getAuthorizedDevice(deviceId, context);

  if (!target?.route || deviceId === getOrCreateDeviceId(context)) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
  const channelId = deviceChannelIdentity(getOrCreateDeviceId(context), deviceId);
  const key = `device_history_v2:${deviceId}`;
  const previous = await context.vault.db.meta.get(key);
  let history: SyncReqFrame["history"];

  if (previous) {
    history = JSON.parse(previous.value);

    if (policy && history?.policy !== policy) throw new Error("HISTORY_POLICY_ALREADY_SELECTED");

    if (fromSourceDeviceId) {
      const source = await context.vault.db.meta.get(`device_history_v2:${fromSourceDeviceId}`);

      if (!source || source.value !== previous.value) throw new Error("HISTORY_POLICY_ALREADY_SELECTED");
    }
  } else {
    const fromSource = fromSourceDeviceId ? await context.vault.db.meta.get(`device_history_v2:${fromSourceDeviceId}`) : undefined;

    if (fromSourceDeviceId && !fromSource) throw new Error("HISTORY_POLICY_REQUIRED");

    if (!policy && !fromSource) throw new Error("HISTORY_POLICY_REQUIRED");
    history = fromSource ? JSON.parse(fromSource.value) : { v: 2, policy: policy!, fromTs: policy === "ALL" ? 0 : policy === "LAST_30_DAYS" ? Date.now() - 30 * 24 * 60 * 60 * 1000 : Date.now() };

    if (policy && history?.policy !== policy) throw new Error("HISTORY_POLICY_ALREADY_SELECTED");
    const value = JSON.stringify(history);
    await writeVault(context.vault, [context.vault.db.meta], async () => {
      if (await context.vault.db.meta.get(key)) throw new Error("HISTORY_POLICY_CONFLICT");
      await context.vault.db.meta.put({ key, value });
    });
  }

  await connectConversation(channelId, { kind: "device", deviceAuthorizationVersion: 2,
    accountRootIdentity: target.accountRootIdentityPub, identityPub: target.identityPub, dhPub: target.dhPub,
    peerDeviceId: target.deviceId, friendKeyId: target.deviceId, onionAddr: target.route.onionAddr,
    inboxWriteToken: target.route.inboxWriteToken }, context);

  await ensureFreshOutboundSession(channelId, target, context);

  if (await pendingHistoryRequest(channelId, context)) return;

  const inventoried = getPeerCaps(channelId, context).sync.inventory === 1;
  // Legacy peers use bounded exact IDs; omitted IDs may resend idempotently.

  const knownEventIds = inventoried ? [] : [...new Set((await listEventsByConv(channelId, context.vault))
    .filter(event => event.applicationState === "stored" && event.authorDeviceId === deviceId)
    .map(event => (readEventEnvelope(event)).header.deviceDelivery?.deliveryId ?? event.eventId))].slice(-512);

  const request: SyncReqFrame = { type: "SYNC_REQ", scope: "global", convId: channelId, since: {}, history, knownEventIds };

  if (inventoried) request.inventoryVersion = 1;

  await sendFrame(channelId, request, context);
};

export const getHistorySnapshotProgress = async (deviceId: string, requestId: string, captured?: ReceiveContext) => {
  let context = captured ?? await captureLocalOperationContext();

  if (context) context = await captureDeviceRegistryContext(context);
  const source = context && await getAuthorizedDevice(deviceId, context);

  if (!context || !source) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
  const progress = await readHistoryInventory(deviceChannelIdentity(getOrCreateDeviceId(context), deviceId), requestId, context);

  if (progress && (progress.binding.sourceEpoch !== source.epoch || progress.binding.sourceIdentityPub !== source.identityPub ||
    progress.binding.accountIdentity !== await getAccountRootIdentity(context))) throw new Error("HISTORY_SNAPSHOT_AUTHORITY_CHANGED");

  await captureDeviceRegistryContext(context);

  return progress;
};

export const resumeApprovedDeviceHistory = async (deviceId: string, requestId: string, captured?: ReceiveContext) => {
  const context = captured ?? await captureLocalOperationContext();

  if (!context) throw new Error("OWNER_REQUIRED");

  return withFriendControlLock(`history-request:${ownerKey(deviceId, context)}`,
    () => resumeApprovedDeviceHistoryNow(deviceId, requestId, context));
};

const resumeApprovedDeviceHistoryNow = async (deviceId: string, requestId: string, context: ReceiveContext) => {
  const progress = await getHistorySnapshotProgress(deviceId, requestId, context);
  const target = await getAuthorizedDevice(deviceId, context);

  if (!progress || !target?.route) throw new Error("HISTORY_SNAPSHOT_UNAVAILABLE");

  if (progress.snapshotApplied) return;
  const channel = deviceChannelIdentity(getOrCreateDeviceId(context), deviceId);
  await ensureFreshOutboundSession(channel, target, context);

  if (getPeerCaps(channel, context).sync.inventory !== 1) throw new Error("HISTORY_INVENTORY_REQUIRED");

  if (await pendingHistoryRequest(channel, context, requestId)) return;
  await sendFrame(channel, { type: "SYNC_REQ", scope: "global", convId: channel, since: {}, knownEventIds: [],
    history: progress.binding.history, inventoryVersion: 1, resumeInventory: { requestId, snapshotId: progress.snapshotId } }, context);
};

/** One attempt per authenticated session; prior incoming Inventory distinguishes return from initial bootstrap. */
const scheduleHistoryCatchup = (channel: string, captured: ReceiveContext) => {
  const key = ownerKey(channel, captured), session = freshSessions.get(key);

  if (!session?.outbound || session.historyCatchupScheduled) return;
  session.historyCatchupScheduled = true;
  setTimeout(() => { void withFriendControlLock(`history-catchup:${key}`, async () => {
      const context = await captureDeviceRegistryContext(Object.freeze({ ...captured,
        owner: Object.freeze({ ...captured.owner, mailboxDeviceId: "" }) }));

      const peer = peerContexts.get(key), source = peer?.peerDeviceId && await getAuthorizedDevice(peer.peerDeviceId, context);

      if (!source || peer?.kind !== "device" || source.accountRootIdentityPub !== await getAccountRootIdentity(context) ||
        freshSessions.get(key) !== session || !getCertifiedSessionState(channel, context).ready ||
        getPeerCaps(channel, context).sync.inventory !== 1) return;
      const selected = await context.vault.db.meta.get(`device_history_v2:${source.deviceId}`);

      if (!selected) return;
      const history: NonNullable<SyncReqFrame["history"]> = JSON.parse(selected.value);

      const previous = await findHistoryInventory(channel, { accountIdentity: source.accountRootIdentityPub,
        requesterDeviceId: getOrCreateDeviceId(context), sourceDeviceId: source.deviceId, sourceIdentityPub: source.identityPub,
        sourceEpoch: source.epoch, scope: "global", history }, context);

      if (!previous) return;

      if (freshSessions.get(key) !== session) return;

      if (previous.resumable) await resumeApprovedDeviceHistory(source.deviceId, previous.requestId, context);
      else await syncApprovedDeviceHistory(source.deviceId, undefined, context);
    }).catch(error => {
      const code = error instanceof Error && ["OWNER_SESSION_CHANGED", "DEVICE_AUTHORITY_CHANGED", "DEVICE_AUTHORIZATION_REQUIRED",
        "HISTORY_SNAPSHOT_AUTHORITY_CHANGED", "HISTORY_SNAPSHOT_UNAVAILABLE", "FRESH_SESSION_REQUIRED"].includes(error.message)
        ? error.message : "HISTORY_CATCHUP_FAILED";

      console.warn("[sync] automatic history deferred", { code });
    }); }, 0);
};

const buildRoleChangeEvent = async (
  convId: string,
  payload: RoleChangeEvent,
  identityPriv: Uint8Array, context?: ReceiveContext
) => {
  context?.vault.assertLocal();
  const logId = globalLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId, context);
  const legacyKey = await resolveLegacyKey(convId, context);

  if (!ratchetBaseKey || !legacyKey) return null;
  const deviceId = getOrCreateDeviceId(context);
  let nextLamport = perAuthorLamportSeen.get(ownerKey(deviceId, context)) ?? 0;
  nextLamport += 1;

  const header: EnvelopeHeader = {
    v: 1 as const,
    eventId: createId(),
    convId: logId,
    ts: payload.ts,
    lamport: nextLamport,
    authorDeviceId: deviceId,
  };

  header.prev = await getLastEventHash(logId, context?.vault);
  const keyForEnvelope = await resolveSendEnvelopeKey(convId, logId, ratchetBaseKey, legacyKey, context);

  if (keyForEnvelope.headerRk) header.rk = keyForEnvelope.headerRk;
  header.friendSessionId = keyForEnvelope.friendSessionId;

  const envelope = await encryptEnvelope(keyForEnvelope.msgKey, header, payload, identityPriv);
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
  }, context?.vault);
  updateLamportSeen(logId, header.authorDeviceId, header.lamport, context);

  return event;
};

export const emitRoleChangeEvent = async (payload: RoleChangeEvent, context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  const identityPriv = await getIdentityPrivateKey(context);
  const activeConvs = peerConversationIds(context);

  for (const convId of activeConvs) {
    try {
      const capsKnown = hasKnownPeerCaps(convId, context);

      if (capsKnown && !canUseRoleEvents(getPeerCaps(convId, context))) continue;
      const event = await buildRoleChangeEvent(convId, payload, identityPriv, context);

      if (!event) continue;

      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "global",
        convId,
        events: [event],
        next: buildNextMap([event]),
      };

      await sendFrame(convId, frame, context);
    } catch (error) {
      console.warn("[sync] role change emit failed", error);
    }
  }
};

const buildContactEvents = async (convId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer?.friendKeyId || !peer.dhPub) return [];
  const logId = contactsLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId, context);
  const legacyKey = await resolveLegacyKey(convId, context);

  if (!ratchetBaseKey || !legacyKey) return [];
  const identityPriv = await getIdentityPrivateKey(context);
  const deviceId = getOrCreateDeviceId(context);
  let nextLamport = perAuthorLamportSeen.get(ownerKey(deviceId, context)) ?? 0;

  const profiles = await listProfiles(context?.vault);
  const contacts = profiles.filter((profile) => profile.kind === "friend");
  const events: EnvelopeEvent[] = [];

  let prevHash = await getLastEventHash(logId, context?.vault);

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
    const keyForEnvelope = await resolveSendEnvelopeKey(convId, logId, ratchetBaseKey, legacyKey, context);

    if (keyForEnvelope.headerRk) header.rk = keyForEnvelope.headerRk;
    header.friendSessionId = keyForEnvelope.friendSessionId;

    const envelope = await encryptEnvelope(
      keyForEnvelope.msgKey,
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
          primaryDeviceId: contact.primaryDeviceId,
          profileVcard: contact.profileVcard,
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
    updateLamportSeen(logId, header.authorDeviceId, header.lamport, context);
    await saveEvent({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
      prevHash: header.prev,
      eventHash,
    }, context?.vault);
  }

  return events;
};

const buildConversationEvents = async (convId: string, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  const peer = peerContexts.get(ownerKey(convId, context));

  if (!peer?.friendKeyId || !peer.dhPub) return [];
  const logId = conversationsLogId(convId);
  const ratchetBaseKey = await resolveRatchetBaseKey(convId, logId, context);
  const legacyKey = await resolveLegacyKey(convId, context);

  if (!ratchetBaseKey || !legacyKey) return [];
  const identityPriv = await getIdentityPrivateKey(context);
  const deviceId = getOrCreateDeviceId(context);
  let nextLamport = perAuthorLamportSeen.get(ownerKey(deviceId, context)) ?? 0;

  const conversations = await listConversations(context?.vault);
  const events: EnvelopeEvent[] = [];

  let prevHash = await getLastEventHash(logId, context?.vault);

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
    const keyForEnvelope = await resolveSendEnvelopeKey(convId, logId, ratchetBaseKey, legacyKey, context);

    if (keyForEnvelope.headerRk) header.rk = keyForEnvelope.headerRk;
    header.friendSessionId = keyForEnvelope.friendSessionId;

    const envelope = await encryptEnvelope(
      keyForEnvelope.msgKey,
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
          pendingOutgoing: conversation.pendingOutgoing,
          pendingFriendResponse: conversation.pendingFriendResponse,
          lastTs: conversation.lastTs,
          lastMessage: conversation.lastMessage,
          participants: conversation.participants,
          sharedAvatarRef: conversation.sharedAvatarRef,
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
    updateLamportSeen(logId, header.authorDeviceId, header.lamport, context);
    await saveEvent({
      eventId: header.eventId,
      convId: logId,
      authorDeviceId: header.authorDeviceId,
      lamport: header.lamport,
      ts: header.ts,
      envelopeJson: JSON.stringify(envelope),
      prevHash: header.prev,
      eventHash,
    }, context?.vault);
  }

  return events;
};

export const syncContactsNow = async (context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  const activeConvs = peerConversationIds(context);

  for (const convId of activeConvs) {
    try {
      const peer = peerContexts.get(ownerKey(convId, context));

      if (peer?.kind !== "device") continue;
      const allowed = await isDeviceSyncAllowed(convId, "sync_contacts", context);

      if (!allowed) continue;
      const since = getSinceMap(contactsLogId(convId), context);

      const req: SyncReqFrame = {
        type: "SYNC_REQ",
        scope: "contacts",
        convId,
        since,
      };

      await sendFrame(convId, req, context);

      const events = await buildContactEvents(convId, context);

      if (!events.length) continue;
      const next = buildNextMap(events);

      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "contacts",
        convId,
        events,
        next,
      };

      await sendFrame(convId, frame, context);
    } catch (error) {
      console.warn("[sync] contacts sync failed", error);
    }
  }
};

export const syncConversationsNow = async (context?: ReceiveContext) => {
  context ??= await captureLocalOperationContext();
  context?.vault.assertLocal();
  const activeConvs = peerConversationIds(context);

  for (const convId of activeConvs) {
    try {
      const peer = peerContexts.get(ownerKey(convId, context));

      if (peer?.kind !== "device") continue;
      const allowed = await isDeviceSyncAllowed(convId, "sync_conversations", context);

      if (!allowed) continue;
      const since = getSinceMap(conversationsLogId(convId), context);

      const req: SyncReqFrame = {
        type: "SYNC_REQ",
        scope: "conversations",
        convId,
        since,
      };

      await sendFrame(convId, req, context);

      const events = await buildConversationEvents(convId, context);

      if (!events.length) continue;
      const next = buildNextMap(events);

      const frame: SyncResFrame = {
        type: "SYNC_RES",
        scope: "conversations",
        convId,
        events,
        next,
      };

      await sendFrame(convId, frame, context);
    } catch (error) {
      console.warn("[sync] conversations sync failed", error);
    }
  }
};

export const __testWithReceiveChain = withReceiveChain;

export const __testApplyEnvelopeEvents = applyEnvelopeEvents;

export const __testApplyMessageEvent = applyMessageEvent;

export const __testApplyContactEvent = applyContactEvent;

export const __testApplyConversationEvent = applyConversationEvent;

export const __testRepairDirectConversationPeerBinding = repairDirectConversationPeerBinding;

export const __testRefreshAuthenticatedReplyRoute = refreshAuthenticatedReplyRoute;

export const __testRefreshAuthenticatedFriendReplyRoute = refreshAuthenticatedFriendReplyRoute;

export const __testHandleAck = handleAck;

export const __testHandleHello = handleHello;

export const __testGetPeerContext = (convId: string, context?: ReceiveContext) => peerContexts.get(ownerKey(convId, context));

export const __testSetPeerContext = (convId: string, peer: PeerContext, context?: ReceiveContext) => {
  context?.vault.assertLocal();
  setReceiveCache(context, peerContexts, ownerKey(convId, context), peer);
};

export const __testCreateSyncResponseFrames = (input: {
  scope: SyncReqFrame["scope"];
  convId?: string;
  events: EnvelopeEvent[];
  next: Record<string, number>;
  flowControl: boolean;
}) =>
  createSyncResponseFrames(
    {
      type: "SYNC_RES",
      scope: input.scope,
      convId: input.convId,
    },
    input.events,
    input.next,
    input.flowControl
  );

export const __testSendSyncResponseFrames = sendSyncResponseFrames;
export const __testHandleSyncFlowAck = handleSyncFlowAck;

const clearOwnedSyncState = () => {
  for (const offer of freshOffers.values()) offer.privateKey.fill(0);

  for (const session of freshSessions.values()) { session.outbound?.key.fill(0); session.inbound?.key.fill(0); }

  for (const candidate of freshCandidates.values()) candidate.key.fill(0);
  freshOffers.clear(); freshSessions.clear(); freshCandidates.clear(); freshPeerControlTimes.clear(); freshSessionWaiters.clear(); freshRecoveryStatus.clear(); freshSendStages.clear(); freshReceiveStages.clear();
  perAuthorLamportSeen.clear();
  perConvLamportSeen.clear();
  peerContexts.clear();
  pendingHelloNonces.clear();
  seenHelloNonces.clear();
  deferredRoleEvents.clear();
  pendingMediaChunks.clear();
  localUserIdCache = undefined;

  for (const unsubscribe of convSubscriptions.values()) unsubscribe();
  convSubscriptions.clear();
  Array.from(outgoingFlowSessions.keys()).forEach(clearFlowSession);
};

onAccountOwnerChange(clearOwnedSyncState);

onVaultKeyChange(clearOwnedSyncState);

export const __testResetSyncState = () => {
  clearOwnedSyncState();
  quarantinedRatchets.clear();
  friendControlLocks.clear();
  syncTransportOverride = null;
};
