import { legacyOutboxCiphertext } from "../storage/storedPayload";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { acquireMainAccountSession, onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { db, ensureDbOpen, type OutboxRecord } from "../db/schema";
import { listConversations, listProfiles, type Conversation, type UserProfile } from "../db/repo";
import { getVaultKey, onVaultKeyChange } from "../crypto/sessionKeyring";
import { decryptJsonRecord, encryptJsonRecord } from "../crypto/vault";
import { deriveConversationKeyPair, type Envelope } from "../crypto/box";
import { hasAuthenticatedFriendKeys } from "../security/trust";
import { getDhPrivateKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { getFriendPsk } from "../security/pskStore";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { sha256 } from "../security/sha256";
import { createExperimentalUnifiedRatchetManager, type OrderedTextContext } from "./orderedTextReceiver";
import { createDisposableUnifiedRecovery } from "./unifiedRecoveryExperiment";
import { isUnifiedTextChannel, unifiedAppExperimentEnabled, unifiedAppRecoveryEnabled } from "./unifiedAppPolicy";

type NativeRoute = { accountId: string; friendId: string; onionAddress: string; inboxWriteToken: string };

type PeerAdmission = { identity: string; dh: string; device: string; version: 2 };

let owner: { db: typeof db; account: string; key: Uint8Array;
  manager: ReturnType<typeof createExperimentalUnifiedRatchetManager> | ReturnType<typeof createDisposableUnifiedRecovery> } | null = null;

let recoveryTestCheckpoint: ((stage: string) => Promise<void>) | null = null;

/** Only a disposable Phase 2Q profile may install a crash-test checkpoint. */
export const setDisposableRecoveryTestCheckpoint = (callback: ((stage: string) => Promise<void>) | null) => {
  if (!unifiedAppRecoveryEnabled()) throw new Error("RECOVERY_PROFILE_BLOCKED");
  recoveryTestCheckpoint = callback;
};

export const closeUnifiedAppRatchet = () => { owner?.manager.close(); owner = null; };

onVaultKeyChange(closeUnifiedAppRatchet);

onAccountOwnerChange(closeUnifiedAppRatchet);

/** Explicit local fixture enrollment, never inferred from rk.v2 or enabled for ordinary profiles. */
export const admitDisposableUnifiedPeer = async (peer: UserProfile, version: 2) => {
  const current = await manager();
  const device = peer.primaryDeviceId ?? peer.routingHints?.deviceId ?? peer.deviceId;

  if (version !== 2 || peer.friendStatus !== "normal" || !peer.identityPub || !peer.dhPub || !device ||
      decodeBase64Url(peer.identityPub).length !== 32 || decodeBase64Url(peer.dhPub).length !== 32) throw new Error("V2_EXPERIMENT_PEER_REQUIRED");
  const key = `phase2i:peer:${peer.id}`;
  const admission: PeerAdmission = { identity: peer.identityPub, dh: peer.dhPub, device, version };
  const before = await current.db.meta.get(key);

  if (before) {
    const pinned = await decryptJsonRecord<PeerAdmission>(current.key, key, "unified-peer-v1", before.value);

    if (JSON.stringify(pinned) !== JSON.stringify(admission)) throw new Error("PINNED_EXPERIMENT_PEER_CHANGED");

    return;
  }

  const encrypted = await encryptJsonRecord(current.key, key, "unified-peer-v1", admission);

  if (owner !== current || getVaultKey() !== current.key || getActiveAccountId() !== current.account) throw new Error("OWNER_CHANGED");
  await current.db.transaction("rw", current.db.meta, async () => {
    if (await current.db.meta.get(key)) throw new Error("EXPERIMENT_PEER_ENROLLMENT_RACE");
    await current.db.meta.add({ key, value: encrypted });
  });
};

const manager = async () => {
  if (!unifiedAppExperimentEnabled()) throw new Error("EXPERIMENT_BLOCKED");
  const key = getVaultKey();

  if (!key) throw new Error("VAULT_LOCKED");
  const selectedDatabase = db, selectedAccount = getActiveAccountId();
  await ensureDbOpen();

  if (db !== selectedDatabase || getVaultKey() !== key || getActiveAccountId() !== selectedAccount) throw new Error("OWNER_CHANGED");
  const account = getActiveAccountId();

  if (unifiedAppRecoveryEnabled() && await window.nkcExperimental?.preflight?.status() !== "verified") {
    throw new Error("PREFLIGHT_REQUIRED");
  }

  if (owner && (owner.db !== db || owner.key !== key || owner.account !== account)) closeUnifiedAppRatchet();

  if (!owner) owner = { db, account, key, manager: unifiedAppRecoveryEnabled()
    ? createDisposableUnifiedRecovery({ database: db, accountId: account, vaultKey: key, disposableProfile: true,
      appIntegration: true, checkpoint: async stage => recoveryTestCheckpoint?.(stage),
      sessionValid: async () => getVaultKey() === key && getActiveAccountId() === account &&
        db === selectedDatabase && await window.nkcExperimental?.preflight?.status() === "verified" })
    : createExperimentalUnifiedRatchetManager({
      database: db, accountId: account, vaultKey: key, disposableProfile: true, nativeOutboxOwner: true,
    }) };

  return owner;
};

/** On unlocked startup, drain retained signed inputs before any later send derives Root/DH. */
export const recoverUnifiedAppPending = async () => {
  if (!unifiedAppRecoveryEnabled() || !getVaultKey()) return 0;
  const current = await manager();

  if (!("recover" in current.manager)) throw new Error("RECOVERY_OWNER_MISSING");
  const prefix = `phase2p:inbound:${current.account}:`;
  const records = await current.db.meta.where("key").startsWith(prefix).toArray();

  if (!records.length) return 0;
  const [conversations, profiles] = await Promise.all([listConversations(), listProfiles()]);
  const local = profiles.find(profile => profile.kind === "user");
  let stored = 0;

  for (const record of records) {
    if (owner !== current || getVaultKey() !== current.key || getActiveAccountId() !== current.account) throw new Error("OWNER_CHANGED");
    const id = record.key.slice(prefix.length);

    const conversation = conversations.find(item => item.id === id && item.type !== "group" &&
      local && item.participants.includes(local.id));

    const peerId = conversation?.participants.find(item => item !== local?.id);
    const peer = profiles.find(item => item.id === peerId && item.kind === "friend");

    if (!conversation || !peer) throw new Error("RECOVERY_CONTEXT_UNAVAILABLE");
    const context = await unifiedAppContext(conversation, peer);
    const result = await current.manager.recover(context);

    if (result.outcome === "stored") stored++;
  }

  return stored;
};

/** A fresh domain-separated text channel; control/media channels retain their existing owner.
 * Both test peers must opt in. This is not a negotiated peer capability or an import of old keys. */
export const unifiedAppContext = async (conversation: Conversation, peer: UserProfile): Promise<OrderedTextContext> => {
  const current = await manager();

  if (!unifiedAppExperimentEnabled() || conversation.type === "group" || conversation.participants.length !== 2 ||
      peer.friendStatus !== "normal" || !peer.identityPub || !peer.dhPub || conversation.blocked ||
      conversation.pendingAcceptance) throw new Error("EXPERIMENT_PEER_REQUIRED");
  if (!hasAuthenticatedFriendKeys(peer)) throw new Error("FRIEND_AUTHENTICATION_REQUIRED");
  const author = peer.primaryDeviceId ?? peer.routingHints?.deviceId ?? peer.deviceId;

  if (!author) throw new Error("PINNED_DEVICE_REQUIRED");
  const peerKey = `phase2i:peer:${peer.id}`;
  const enrolled = await current.db.meta.get(peerKey);

  if (!enrolled) throw new Error("V2_EXPERIMENT_PEER_REQUIRED");
  const admission = await decryptJsonRecord<PeerAdmission>(current.key, peerKey, "unified-peer-v1", enrolled.value);

  if (admission.version !== 2 || admission.device !== author || admission.identity !== peer.identityPub || admission.dh !== peer.dhPub) {
    throw new Error("V2_EXPERIMENT_PEER_REQUIRED");
  }

  const localIdentity = encodeBase64Url(await getIdentityPublicKey());

  const wireConversation = `phase2i:${encodeBase64Url(sha256(new TextEncoder().encode(
    JSON.stringify([localIdentity, peer.identityPub].sort()))))}`;

  const friendKeyId = peer.friendId ?? peer.id;

  const keys = await deriveConversationKeyPair(await getDhPrivateKey(), decodeBase64Url(peer.dhPub),
    await getFriendPsk(friendKeyId), new TextEncoder().encode(`direct:${friendKeyId}`),
    new TextEncoder().encode(`conv:${wireConversation}`));

  if (owner !== current || getVaultKey() !== current.key || getActiveAccountId() !== current.account) throw new Error("OWNER_CHANGED");

  return { accountId: current.account, localConversation: conversation.id, wireConversation,
    author, verifyKey: decodeBase64Url(peer.identityPub), baseKey: keys.ratchetBaseKey,
    legacyKey: keys.conversationKey, peerSenderId: peer.id };
};

const handoff = async (record: OutboxRecord) => {
  const current = await manager();
  const session = await acquireMainAccountSession(current.account);

  if (!["prepared", "handoff_in_progress", "result_uncertain"].includes(record.status) || !record.nativeRoute_enc) return;
  const route = await decryptJsonRecord<NativeRoute>(current.key, record.id, "native-handoff-v1", record.nativeRoute_enc);

  if (route.accountId !== current.account || !window.p2pQueue) throw new Error("HANDOFF_ACCOUNT_MISMATCH");
  const sameOwner = () => owner === current && getVaultKey() === current.key && getActiveAccountId() === current.account;

  if (!sameOwner()) throw new Error("OWNER_CHANGED");
  await current.db.transaction("rw", current.db.outbox, async () => {
    const latest = await current.db.outbox.get(record.id);

    if (!latest || latest.ciphertext !== record.ciphertext || latest.nativeRoute_enc !== record.nativeRoute_enc ||
        !["prepared", "handoff_in_progress", "result_uncertain"].includes(latest.status)) throw new Error("HANDOFF_OWNER_CHANGED");
    await current.db.outbox.update(record.id, { status: "handoff_in_progress" });
  });
  let result: Awaited<ReturnType<NonNullable<typeof window.p2pQueue>["handoffUnified"]>>;

  try {
    result = await window.p2pQueue.handoffUnified({ ...route, id: record.id, payload: legacyOutboxCiphertext(record) }, session);

    if (!result.ok) throw new Error("HANDOFF_UNCERTAIN");
  } catch {
    if (sameOwner()) await current.db.transaction("rw", current.db.outbox, async () => {
      if ((await current.db.outbox.get(record.id))?.status === "handoff_in_progress")
        await current.db.outbox.update(record.id, { status: "result_uncertain" });
    });
    throw new Error("HANDOFF_UNCERTAIN");
  }

  // After a lost IPC result, the same immutable enqueue is replayed; only the Worker sends on the network.
  // A terminal Worker status is a local transport outcome, never recipient application storage.
  if (!sameOwner()) return;
  await current.db.transaction("rw", current.db.outbox, async () => {
    if ((await current.db.outbox.get(record.id))?.status === "handoff_in_progress")
      await current.db.outbox.update(record.id, { status: result.status === "DELIVERED" || result.status === "FAILED" ? "native_terminal" : "native_owned" });
  });
};

export const recoverUnifiedAppOutbox = async () => {
  if (!unifiedAppExperimentEnabled() || !getVaultKey()) return;

  if (unifiedAppRecoveryEnabled()) await recoverUnifiedAppPending();
  const current = await manager();
  const records = await current.db.outbox.where("status").anyOf("prepared", "handoff_in_progress", "result_uncertain").toArray();

  for (const record of records) {
    if (owner !== current || getVaultKey() !== current.key || getActiveAccountId() !== current.account) return;
    await handoff(record);
  }
};

export const sendUnifiedAppText = async (conversation: Conversation, peer: UserProfile,
  request: { id: string; text: string; ts: number; senderId: string }) => {
  // A receive in this account may have advanced the shared v2 Root/DH state.
  // Resolve every retained intake before preparing another send candidate.
  if (unifiedAppRecoveryEnabled()) await recoverUnifiedAppPending();
  const context = await unifiedAppContext(conversation, peer);
  context.localSenderId = request.senderId;

  const route: NativeRoute = { accountId: context.accountId,
    friendId: peer.routingHints?.deviceId ?? peer.primaryDeviceId ?? "",
    onionAddress: peer.routingHints?.onionAddr ?? "", inboxWriteToken: peer.routingHints?.inboxWriteToken ?? "" };

  if (!route.friendId || !/^[a-z2-7]{56}\.onion$/.test(route.onionAddress) || !route.inboxWriteToken) {
    throw new Error("AUTHENTICATED_ONION_ROUTE_REQUIRED");
  }

  const current = await manager();

  const result = await current.manager.sendText(context, { eventId: request.id, author: getOrCreateDeviceId(),
    signKey: await getIdentityPrivateKey(), text: request.text, lamport: 1, ts: request.ts, version: 2, nativeRoute: route });

  const record = await current.db.outbox.get(request.id);

  if (!record) throw new Error("COMMITTED_OUTBOX_MISSING");
  await handoff(record);

  return result;
};

export const receiveUnifiedAppText = async (conversation: Conversation, peer: UserProfile, envelope: Envelope,
  outer: { eventId: string; convId: string; authorDeviceId: string; lamport: number; ts: number }) => {
  if (!isUnifiedTextChannel(envelope.header.convId)) throw new Error("UNIFIED_CHANNEL_REQUIRED");
  const context = await unifiedAppContext(conversation, peer);

  if (context.wireConversation !== envelope.header.convId || envelope.header.rk?.v !== 2) {
    throw new Error("UNIFIED_PEER_OR_VERSION_MISMATCH");
  }

  return (await manager()).manager.receive(context, envelope, outer);
};
