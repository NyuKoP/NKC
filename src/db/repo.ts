import { legacyEventJson, legacyOutboxCiphertext, readEventEnvelope, samePayloadBytes } from "../storage/storedPayload";
import { computeEnvelopeHash } from "../crypto/box";
import { getAccountOwnerGeneration } from "../accounts/accountOwnerLifecycle";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import { assertAvatarPreviewBudget } from "../security/avatarBudget";
import Dexie from "dexie";
import { notifyMessageMediaReady } from "../storage/mediaReady";
import { mediaCustodyKey, readMediaCustody } from "../storage/mediaCustody";
import { db as activeDb, deleteVaultDatabase, resetDb } from "./schema";
import { ensureVaultAccess, writeVault, type VaultAccess } from "./vaultAccess";
import type {
  EncryptedRecord,
  EventRecord,
  MediaChunkRecord,
  MessageRecord,
  OutboxRecord,
} from "./schema";
import type { Envelope } from "../crypto/box";
import {
  chunkBuffer,
  createVaultHeader,
  decodeBinaryEnvelope,
  decryptJsonRecord,
  deriveMkm,
  deriveVk,
  encodeBinaryEnvelope,
  encryptJsonRecord,
  sameStoredCiphertext,
  type VaultHeader,
} from "../crypto/vault";
import { clearVaultKey, getVaultKey, setVaultKey, computeVaultKeyId } from "../crypto/sessionKeyring";
import { createId } from "../utils/ids";
import { buildReceivedText, type LogicalMessage, type LogicalMediaChunk } from "../sync/receivedText";
import { canonicalBytes } from "../crypto/canonicalJson";
import { mapLimit } from "../utils/async";
import { parseAvatarRef, serializeAvatarRef } from "../utils/avatarRefs";
import type { ProfilePresence } from "../profile/presence";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import {
  hasValidPreviewSignature,
  inspectAvatarImageFile,
  inspectOutgoingMediaFile,
  isPreviewMediaClaim,
  isSafePreviewMime,
  isValidMediaOwnerId,
  normalizeMediaMime,
  parseIncomingMediaRef,
  sanitizeMediaFilename,
  type PreparedMediaMetadata,
} from "../security/mediaPolicy";

export type AvatarRef = {
  ownerType: "profile" | "group";
  ownerId: string;
  mime: string;
  total: number;
  chunkSize: number;
  revision?: string;
  size?: number;
};

export type MediaRef = {
  ownerType: "message";
  ownerId: string;
  mime: string;
  total: number;
  chunkSize: number;
  name: string;
  size: number;
};

export type MessageMediaChunk = {
  idx: number;
  total: number;
  bytes: Uint8Array;
};

export const createMessageMediaRef = (
  messageId: string,
  file: File,
  chunkSize = MEDIA_CHUNK_SIZE,
  metadata?: PreparedMediaMetadata
): MediaRef => {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize > MAX_MEDIA_CHUNK_SIZE) {
    throw new Error("Invalid media chunk size");
  }

  if (file.size <= 0 || file.size > MAX_MEDIA_BYTES) {
    throw new Error("Invalid media size");
  }

  return {
    ownerType: "message",
    ownerId: messageId,
    mime: metadata?.mime ?? normalizeMediaMime(file.type),
    total: Math.ceil(file.size / chunkSize),
    chunkSize,
    name: metadata?.name ?? sanitizeMediaFilename(file.name),
    size: file.size,
  };
};

export type UserProfile = {
  id: string;
  displayName: string;
  status: string;
  theme: "dark" | "light";
  avatarRef?: AvatarRef;
  presence?: ProfilePresence;
  kind: "user" | "friend";
  friendId?: string;
  deviceId?: string;
  primaryDeviceId?: string;
  identityPub?: string;
  dhPub?: string;
  routingHints?: { onionAddr?: string; deviceId?: string; inboxWriteToken?: string };
  trust?: { pinnedAt: number; status: "trusted" | "blocked" | "changed"; reason?: string };
  verification?: {
    status: "unverified" | "verified" | "key_changed" | "blocked";
    safetyNumber?: string;
    verifiedAt?: number;
  };
  reachability?: {
    status: "ok" | "unreachable" | "expired";
    lastError?: string;
    attempts?: number;
    nextAttemptAt?: number;
    lastAttemptAt?: number;
  };
  profileVcard?: {
    displayName?: string;
    status?: string;
    avatarRef?: AvatarRef;
    friendCode?: string;
    updatedAt?: number;
  };
  pskHint?: boolean;
  friendStatus?: "request_in" | "request_out" | "normal" | "hidden" | "blocked" | "deleted";
  friendControlTs?: number;
  friendKeysAuthenticated?: { identityPub: string; dhPub: string };
  profileUpdatedAt?: number;
  isFavorite?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type Conversation = {
  id: string;
  type?: "direct" | "group";
  name: string;
  pinned: boolean;
  unread: number;
  hidden: boolean;
  muted: boolean;
  blocked: boolean;
  pendingAcceptance?: boolean;
  pendingOutgoing?: boolean;
  pendingFriendResponse?: "accept" | "decline";
  friendshipAccepted?: boolean;
  pendingFriendTarget?: {
    profileId: string;
    friendId: string;
    identityPub: string;
    dhPub: string;
  };
  lastTs: number;
  lastMessage: string;
  participants: string[];
  sharedAvatarRef?: string;
  sharedAvatarAuthorIdentityPub?: string;
};

export type Message = {
  id: string;
  convId: string;
  senderId: string;
  text: string;
  ts: number;
  media?: MediaRef;
  clientBatchId?: string;
  logicalProof?: LogicalMessage;
};

export type MessageEnvelopeRecord = {
  id: string;
  convId: string;
  ts: number;
  envelope: Envelope;
};

export type Event = EventRecord;

export type StoredMessageRecord =
  | { kind: "envelope"; record: MessageEnvelopeRecord }
  | { kind: "legacy"; record: Message };

export type OutboxPayload = { payloadB64u: string };

export type OutboxItem = {
  id: string;
  convId: string;
  createdAt: number;
  ttlMs: number;
  attempt: number;
  nextAttemptAt: number;
  lastError?: string;
};

const VAULT_META_KEY = "vault_header_v2";

const VAULT_KEY_ID_KEY = "vault_key_id_v1";

const TEXT_ENCODING_FIX_KEY = "text_encoding_fix_v1";

const MEDIA_CHUNK_SIZE = 192 * 1024;

const MAX_MEDIA_CHUNK_SIZE = 1024 * 1024;

const MEDIA_DECRYPT_CONCURRENCY = 6;

const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

const MEDIA_YIELD_MIN_CHUNKS = 24;

const MEDIA_YIELD_EVERY = 6;

const MEDIA_DECRYPT_LARGE_CHUNKS = 32;

const MEDIA_DECRYPT_LARGE_CONCURRENCY = 3;

const MEDIA_DECRYPT_BATCH_MULTIPLIER = 4;

const MEDIA_WRITE_BATCH_SIZE = 8;

const OUTBOX_BACKOFF = [1000, 5000, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000] as const;

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const shouldYieldMedia = (index: number, total: number) =>
  total >= MEDIA_YIELD_MIN_CHUNKS && (index + 1) % MEDIA_YIELD_EVERY === 0;

const resolveMediaDecryptConcurrency = (totalChunks: number) =>
  totalChunks >= MEDIA_DECRYPT_LARGE_CHUNKS
    ? Math.min(MEDIA_DECRYPT_LARGE_CONCURRENCY, MEDIA_DECRYPT_CONCURRENCY)
    : MEDIA_DECRYPT_CONCURRENCY;

const nextOutboxAttemptAt = (attempt: number, now: number) =>
  now + OUTBOX_BACKOFF[Math.min(OUTBOX_BACKOFF.length - 1, Math.max(0, attempt))];

const decryptMediaChunks = async (vk: Uint8Array, chunks: MediaChunkRecord[]) => {
  const total = chunks.length;
  const concurrency = resolveMediaDecryptConcurrency(total);
  const batchSize = Math.max(concurrency * MEDIA_DECRYPT_BATCH_MULTIPLIER, concurrency);
  const decrypted: Uint8Array<ArrayBuffer>[] = [];

  for (let start = 0; start < total; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);

    const batchResult = await mapLimit(batch, concurrency, (chunk) =>
      decodeBinaryEnvelope(vk, chunk.id, "mediaChunk", chunk.enc_b64)
    );

    decrypted.push(...batchResult);

    if (total >= MEDIA_YIELD_MIN_CHUNKS && start + batchSize < total) {
      await yieldToEventLoop();
    }
  }

  return decrypted;
};

const decryptMediaToBlob = async (
  vk: Uint8Array,
  chunks: MediaChunkRecord[],
  mime: string,
  maxBytes: number
) => {
  const total = chunks.length;
  const concurrency = resolveMediaDecryptConcurrency(total);
  const batchSize = Math.max(concurrency * MEDIA_DECRYPT_BATCH_MULTIPLIER, concurrency);
  const blobParts: Blob[] = [];
  let totalBytes = 0;

  for (let start = 0; start < total; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);

    const batchResult = await mapLimit(batch, concurrency, (chunk) =>
      decodeBinaryEnvelope(vk, chunk.id, "mediaChunk", chunk.enc_b64)
    );

    if (start === 0) {
      const firstChunk = batchResult[0];

      if (
        !firstChunk ||
        (isPreviewMediaClaim(mime) && !hasValidPreviewSignature(mime, firstChunk))
      ) return null;
    }

    for (const bytes of batchResult) {
      totalBytes += bytes.byteLength;

      if (totalBytes > maxBytes) return null;
    }

    // Move decrypted batches into immutable Blob storage so the JS heap only retains
    // one decryption batch instead of every chunk of a large attachment.
    blobParts.push(new Blob(batchResult));

    if (total >= MEDIA_YIELD_MIN_CHUNKS && start + batchSize < total) {
      await yieldToEventLoop();
    }
  }

  return { blob: new Blob(blobParts, { type: mime }), totalBytes };
};

const requireVaultKey = (access?: VaultAccess) => {
  if (access) { access.assertLocal();

 return access.key; }

  const vk = getVaultKey();

  if (!vk) throw new Error("Vault is locked");

  return vk;
};


export const getVaultKeyId = async (access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const record = await db.meta.get(VAULT_KEY_ID_KEY);

  return record?.value || null;
};

export const setVaultKeyId = async (vk: Uint8Array, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const keyId = await computeVaultKeyId(vk);

  if (!keyId) return null;
  await writeVault(access, [db.meta], () => db.meta.put({ key: VAULT_KEY_ID_KEY, value: keyId }));

  return keyId;
};

export const verifyVaultKeyId = async (vk: Uint8Array, access?: VaultAccess) => {
  await ensureVaultAccess(access);
  const stored = await getVaultKeyId(access);

  if (!stored) return true;
  const current = await computeVaultKeyId(vk);

  if (!current) return true;

  return stored === current;
};

export const getVaultHeader = async (access?: VaultAccess): Promise<VaultHeader | null> => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const record = await db.meta.get(VAULT_META_KEY);

  if (!record) return null;

  try {
    return JSON.parse(record.value) as VaultHeader;
  } catch {
    await writeVault(access, [db.meta], () => db.meta.delete(VAULT_META_KEY));

    return null;
  }
};

const mojibakeMarker = /[ÃÂâêëìíîïðñòóôõöùúûüýþÿ�]/;

const countHangul = (value: string) => (value.match(/[가-힣]/g) ?? []).length;

const repairMojibake = (value: string) => {
  if (!value || !mojibakeMarker.test(value)) return value;

  try {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    if (repaired === value) return value;

    return countHangul(repaired) > countHangul(value) ? repaired : value;
  } catch {
    return value;
  }
};

export const verifyStartKeyForCurrentVault = async (startKey: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  const header = await getVaultHeader(access);

  if (!header) return false;

  const mkm = await deriveMkm(startKey, header);
  const candidateVk = await deriveVk(mkm);

  try {
    const storedKeyId = await getVaultKeyId(access);
    const candidateKeyId = await computeVaultKeyId(candidateVk);

    if (storedKeyId && candidateKeyId) {
      return storedKeyId === candidateKeyId;
    }

    const profile = await db.profiles.toCollection().first();

    if (!profile) return false;

    try {
      await decryptJsonRecord<UserProfile>(
        candidateVk,
        profile.id,
        "profile",
        profile.enc_b64
      );

      return true;
    } catch {
      return false;
    }
  } finally {
    mkm.fill(0);
    candidateVk.fill(0);
  }
};

export const repairVaultTextEncoding = async (access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const meta = await db.meta.get(TEXT_ENCODING_FIX_KEY);

  if (meta?.value === "1") return;

  const vk = requireVaultKey(access);
  const profileRecords = await db.profiles.toArray();

  for (const record of profileRecords) {
    const profile = await decryptJsonRecord<UserProfile>(vk, record.id, "profile", record.enc_b64);
    const displayName = repairMojibake(profile.displayName);
    const status = repairMojibake(profile.status);

    if (displayName !== profile.displayName || status !== profile.status) {
      await saveProfile({ ...profile, displayName, status }, access);
    }
  }

  const conversationRecords = await db.conversations.toArray();

  for (const record of conversationRecords) {
    const conversation = await decryptJsonRecord<Conversation>(
      vk,
      record.id,
      "conv",
      record.enc_b64
    );

    const name = repairMojibake(conversation.name);
    const lastMessage = repairMojibake(conversation.lastMessage);

    if (name !== conversation.name || lastMessage !== conversation.lastMessage) {
      await saveConversation({ ...conversation, name, lastMessage }, access);
    }
  }

  await writeVault(access, [db.meta], () => db.meta.put({ key: TEXT_ENCODING_FIX_KEY, value: "1" }));
};

export const ensureVaultHeader = async (access?: VaultAccess): Promise<VaultHeader> => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const existing = await getVaultHeader(access);

  if (existing) return existing;
  const header = await createVaultHeader();
  await writeVault(access, [db.meta], () => db.meta.put({ key: VAULT_META_KEY, value: JSON.stringify(header) }));

  return header;
};

export const unlockVault = async (startKey: string, access?: VaultAccess) => {
  const header = await ensureVaultHeader(access);
  const mkm = await deriveMkm(startKey, header);
  const vk = await deriveVk(mkm);
  const storedKeyId = await getVaultKeyId(access);
  const candidateKeyId = await computeVaultKeyId(vk);

  if (storedKeyId && candidateKeyId && storedKeyId !== candidateKeyId) {
    vk.fill(0);
    throw new Error("Vault key mismatch");
  }

  setVaultKey(vk);

  if (!storedKeyId) await setVaultKeyId(vk, access);

  return header;
};

export const bootstrapVault = async (access?: VaultAccess) => {
  await ensureVaultHeader(access);

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }

  const vk = new Uint8Array(32);
  globalThis.crypto.getRandomValues(vk);
  setVaultKey(vk);
  await setVaultKeyId(vk, access);
};

export const lockVault = () => {
  clearVaultKey();
};

export const saveProfile = async (profile: UserProfile, access?: VaultAccess, previous?: UserProfile) => {
  if (previous && !access) throw new Error("OWNER_REQUIRED");
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const before = previous ? await db.profiles.get(profile.id) : undefined;

  if (previous && (!before || JSON.stringify(await decryptJsonRecord<UserProfile>(vk, profile.id, "profile", before.enc_b64)) !==
      JSON.stringify(previous))) throw new Error("PROFILE_APPLICATION_CONFLICT");
  const enc_b64 = await encryptJsonRecord(vk, profile.id, "profile", profile);

  const record: EncryptedRecord = {
    id: profile.id,
    enc_b64,
    updatedAt: Date.now(),
  };

  await writeVault(access, [db.profiles], async () => {
    if (previous && (await db.profiles.get(profile.id))?.enc_b64 !== before?.enc_b64) throw new Error("PROFILE_APPLICATION_CONFLICT");
    await db.profiles.put(record);
  });
};

/** Commit an edited profile and its photo under one owned snapshot. */
export const saveProfileWithPhoto = async (profile: UserProfile, previous: UserProfile, file: File, access: VaultAccess) => {
  await access.assertMain();
  const db = access.db;
  const before = await db.profiles.get(profile.id);

  if (!before || JSON.stringify(await decryptJsonRecord<UserProfile>(access.key, profile.id, "profile", before.enc_b64)) !==
      JSON.stringify(previous)) throw new Error("PROFILE_APPLICATION_CONFLICT");
  const avatar = await prepareAvatarPhoto("profile", profile.id, file, access);
  const updated = { ...profile, avatarRef: avatar.avatarRef };
  const enc_b64 = await encryptJsonRecord(access.key, profile.id, "profile", updated);

  await writeVault(access, [db.profiles, db.mediaChunks], async () => {
    if ((await db.profiles.get(profile.id))?.enc_b64 !== before.enc_b64) throw new Error("PROFILE_APPLICATION_CONFLICT");
    await db.mediaChunks.where("ownerId").equals(profile.id).and(chunk => chunk.ownerType === "profile").delete();
    await db.mediaChunks.bulkPut(avatar.records);
    await db.profiles.put({ id: profile.id, enc_b64, updatedAt: Date.now() });
  });

  return updated;
};

export const deleteProfile = async (profileId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  requireVaultKey(access);
  await writeVault(access, [db.profiles], () => db.profiles.delete(profileId));
};

export const listProfiles = async (access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const records = await db.profiles.toArray();

  const profiles = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<UserProfile>(vk, record.id, "profile", record.enc_b64)
    )
  );

  return profiles;
};

export const saveConversation = async (conversation: Conversation, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);

  const enc_b64 = await encryptJsonRecord(
    vk,
    conversation.id,
    "conv",
    conversation
  );

  await writeVault(access, [db.conversations], () => db.conversations.put({
    id: conversation.id,
    enc_b64,
    updatedAt: Date.now(),
  }));
};

/** Pending routing metadata cannot restore a cancelled relationship or overwrite a newer row. */
export const savePendingFriendRequest = async (conversation: Conversation, friend: UserProfile, access: VaultAccess) => {
  await access.assertMain();
  const db = access.db;

  const [beforeProfile, beforeConversation, profiles] = await Promise.all([
    db.profiles.get(friend.id), db.conversations.get(conversation.id), listProfiles(access),
  ]);

  if (!beforeProfile) throw new Error("OWNER_PEER_MISMATCH");
  const current = await decryptJsonRecord<UserProfile>(access.key, friend.id, "profile", beforeProfile.enc_b64);

  const conv = beforeConversation
    ? await decryptJsonRecord<Conversation>(access.key, conversation.id, "conv", beforeConversation.enc_b64) : conversation;

  const localUser = profiles.find(row => row.kind === "user");

  if (current.kind !== "friend" || current.friendStatus !== "request_out" || !current.friendId || !current.identityPub || !current.dhPub ||
      current.friendId !== friend.friendId || current.identityPub !== friend.identityPub || current.dhPub !== friend.dhPub ||
      !localUser || conv.type === "group" || conv.participants.length !== 2 ||
      !conv.participants.includes(localUser.id) || !conv.participants.includes(friend.id)) throw new Error("FRIEND_APPROVAL_STATE_CHANGED");

  const next: Conversation = { ...conv, pendingOutgoing: true, pendingFriendTarget: {
    profileId: current.id, friendId: current.friendId, identityPub: current.identityPub, dhPub: current.dhPub,
  } };

  const enc_b64 = await encryptJsonRecord(access.key, conv.id, "conv", next);
  await writeVault(access, [db.profiles, db.conversations], async () => {
    if ((await db.profiles.get(friend.id))?.enc_b64 !== beforeProfile.enc_b64 ||
        (await db.conversations.get(conv.id))?.enc_b64 !== beforeConversation?.enc_b64) throw new Error("PROFILE_APPLICATION_CONFLICT");
    await db.conversations.put({ id: conv.id, enc_b64, updatedAt: Date.now() });
  });

  return next;
};

/** A local decision changes both records in the captured account or neither. */
export const applyLocalFriendResponse = async (convId: string, friendId: string,
  response: "accept" | "decline" | "block" | "cancel" | "request", access: VaultAccess) => {
  await access.assertMain();
  const db = access.db;
  const [beforeProfile, beforeConversation] = await Promise.all([db.profiles.get(friendId), db.conversations.get(convId)]);

  if (!beforeProfile || !beforeConversation) throw new Error("OWNER_PEER_MISMATCH");

  const [profile, conversation, profiles] = await Promise.all([
    decryptJsonRecord<UserProfile>(access.key, friendId, "profile", beforeProfile.enc_b64),
    decryptJsonRecord<Conversation>(access.key, convId, "conv", beforeConversation.enc_b64),
    listProfiles(access),
  ]);

  const localUser = profiles.find(row => row.kind === "user");

  if (profile.kind !== "friend" || !localUser || conversation.type === "group" || conversation.participants.length !== 2 ||
      !conversation.participants.includes(friendId) || !conversation.participants.includes(localUser.id)) throw new Error("OWNER_PEER_MISMATCH");
  const accepted = response === "accept";

  if (accepted && profile.friendStatus !== "request_in" && profile.friendStatus !== "request_out" &&
      profile.friendStatus !== "normal") throw new Error("FRIEND_APPROVAL_STATE_CHANGED");

  if ((response === "cancel" && profile.friendStatus !== "request_out") ||
      ((response === "block" || response === "request") && profile.friendStatus !== "deleted")) {
    throw new Error("FRIEND_APPROVAL_STATE_CHANGED");
  }

  const now = Date.now();
  const requesting = response === "request", cancelling = response === "cancel";
  const blocked = !accepted && !requesting && !cancelling;

  const nextProfile: UserProfile = { ...profile,
    friendStatus: accepted ? "normal" : requesting ? "request_out" : cancelling ? "hidden" : "blocked", updatedAt: now,
    ...(cancelling ? { reachability: { ...(profile.reachability ?? { status: "unreachable" as const }), nextAttemptAt: undefined } } : {}),
  };

  const nextConversation: Conversation = { ...conversation, blocked, hidden: blocked || cancelling,
    pendingAcceptance: false, pendingOutgoing: requesting,
    pendingFriendResponse: response === "accept" || response === "decline" ? response : undefined,
    friendshipAccepted: accepted,
    ...(requesting ? { lastMessage: "친구 요청을 보냈습니다.", lastTs: now } : {}),
  };

  const [profileCiphertext, conversationCiphertext] = await Promise.all([
    encryptJsonRecord(access.key, friendId, "profile", nextProfile),
    encryptJsonRecord(access.key, convId, "conv", nextConversation),
  ]);

  await writeVault(access, [db.profiles, db.conversations], async () => {
    if ((await db.profiles.get(friendId))?.enc_b64 !== beforeProfile.enc_b64 ||
        (await db.conversations.get(convId))?.enc_b64 !== beforeConversation.enc_b64) throw new Error("PROFILE_APPLICATION_CONFLICT");
    await db.profiles.put({ id: friendId, enc_b64: profileCiphertext, updatedAt: now });
    await db.conversations.put({ id: convId, enc_b64: conversationCiphertext, updatedAt: now });
  });

  return nextProfile;
};

/** Retry completion acknowledges only its pending response, never reapplies relationship state. */
export const completePendingFriendResponse = async (convId: string, response: "accept" | "decline", access: VaultAccess) => {
  await access.assertMain();
  const db = access.db;
  const before = await db.conversations.get(convId);

  if (!before) return false;
  const current = await decryptJsonRecord<Conversation>(access.key, convId, "conv", before.enc_b64);

  if (current.pendingFriendResponse !== response) return false;
  const enc_b64 = await encryptJsonRecord(access.key, convId, "conv", { ...current, pendingFriendResponse: undefined });

  return writeVault(access, [db.conversations], async () => {
    if ((await db.conversations.get(convId))?.enc_b64 !== before.enc_b64) return false;
    await db.conversations.put({ id: convId, enc_b64, updatedAt: Date.now() });

    return true;
  });
};

export const listConversations = async (access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const records = await db.conversations.toArray();

  const conversations = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<Conversation>(vk, record.id, "conv", record.enc_b64)
    )
  );

  return conversations;
};

export const saveMessage = async (message: Message, access?: VaultAccess, format?: "raw-v3") => {
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const keyId = await computeVaultKeyId(vk);
  const previous = await db.messages.get(message.id);

  if ((format === "raw-v3" || previous?.enc_b64 instanceof Uint8Array) && !access) throw new Error("OWNER_REQUIRED");


  const enc_b64 = await encryptJsonRecord(vk, message.id, "message", message,
    previous ? previous.enc_b64 instanceof Uint8Array ? "raw-v3" : undefined : format);

  const record: MessageRecord = {
    id: message.id,
    convId: message.convId,
    ts: message.ts,
    enc_b64,
  };

  const commit = () => writeVault(access, [db.messages, db.meta], async () => {
    const storedKeyId = (await db.meta.get(VAULT_KEY_ID_KEY))?.value;

    if (storedKeyId && storedKeyId !== keyId) throw new Error("OWNER_SESSION_CHANGED");

    if (requireVaultKey(access) !== vk) throw new Error("OWNER_SESSION_CHANGED");
    const current = await db.messages.get(message.id);

    if (!sameStoredCiphertext(current?.enc_b64, previous?.enc_b64) || current?.convId !== previous?.convId ||
        current?.ts !== previous?.ts) throw new Error("OWNER_APPLICATION_CONFLICT");
    await db.messages.put(record);

    if (requireVaultKey(access) !== vk) throw new Error("OWNER_SESSION_CHANGED");
  });

  if (access) await commit();
  else await db.transaction("rw", [db.messages, db.meta], commit);
};

/** A read-only consistency check for a previously authenticated text event. */
export const getStoredMessage = async (id: string, access?: VaultAccess): Promise<Message | null> => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const record = await db.messages.get(id);

  if (!record) return null;
  const message = await decryptJsonRecord<Message>(requireVaultKey(access), id, "message", record.enc_b64);

  if (message.id !== id || message.convId !== record.convId) throw new Error("RECEIVE_MESSAGE_UNAVAILABLE");

  return message;
};

export const listMessagesByConv = async (convId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const records = await db.messages.where("convId").equals(convId).sortBy("ts");

  const messages = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<Message>(vk, record.id, "message", record.enc_b64)
    )
  );

  return messages;
};

export const saveMessageEnvelope = async (record: MessageEnvelopeRecord, access?: VaultAccess, format?: "raw-v3") => {
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const keyId = await computeVaultKeyId(vk);
  const previous = await db.messages.get(record.id);

  if ((format === "raw-v3" || previous?.enc_b64 instanceof Uint8Array) && !access) throw new Error("OWNER_REQUIRED");


  const enc_b64 = await encryptJsonRecord(vk, record.id, "message", record,
    previous ? previous.enc_b64 instanceof Uint8Array ? "raw-v3" : undefined : format);

  const dbRecord: MessageRecord = {
    id: record.id,
    convId: record.convId,
    ts: record.ts,
    enc_b64,
  };

  const commit = () => writeVault(access, [db.messages, db.meta], async () => {
    const storedKeyId = (await db.meta.get(VAULT_KEY_ID_KEY))?.value;

    if (storedKeyId && storedKeyId !== keyId) throw new Error("OWNER_SESSION_CHANGED");

    if (requireVaultKey(access) !== vk) throw new Error("OWNER_SESSION_CHANGED");
    const current = await db.messages.get(record.id);

    if (!sameStoredCiphertext(current?.enc_b64, previous?.enc_b64) || current?.convId !== previous?.convId ||
        current?.ts !== previous?.ts) throw new Error("OWNER_APPLICATION_CONFLICT");
    await db.messages.put(dbRecord);

    if (requireVaultKey(access) !== vk) throw new Error("OWNER_SESSION_CHANGED");
  });

  if (access) await commit();
  else await db.transaction("rw", [db.messages, db.meta], commit);
};

export const listMessageRecordsByConv = async (convId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const records = await db.messages.where("convId").equals(convId).sortBy("ts");

  const decoded = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<unknown>(vk, record.id, "message", record.enc_b64)
    )
  );

  return decoded.map((value) => {
    if (
      value &&
      typeof value === "object" &&
      "envelope" in value &&
      "convId" in value &&
      "ts" in value
    ) {
      return { kind: "envelope", record: value as MessageEnvelopeRecord } as const;
    }

    return { kind: "legacy", record: value as Message } as const;
  });
};

const LAMPORT_PREFIX = "lamport_v1:";

export const nextLamportForConv = async (convId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const key = `${LAMPORT_PREFIX}${convId}`;

  const advance = async () => {
    const current = await db.meta.get(key);
    const parsed = current?.value ? Number.parseInt(current.value, 10) : 0;
    const value = Number.isFinite(parsed) ? parsed : 0;
    const next = value + 1;
    await db.meta.put({ key, value: String(next) });

    return next;
  };

  return access ? writeVault(access, [db.meta], advance) : db.transaction("rw", db.meta, advance);
};

export const saveEvent = async (record: EventRecord, access?: VaultAccess) => {
  if (record.envelopeFormat === "nkce-v1") throw new Error("BINARY_ATOMIC_ADMISSION_REQUIRED");
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  await writeVault(access, [db.events], async () => {
    if ((await db.events.get(record.eventId))?.envelopeFormat === "nkce-v1") throw new Error("OWNER_EVENT_MISMATCH");
    await db.events.put(record);
  });
};

export const getEvent = async (eventId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);

  return db.events.get(eventId);
};

export const markTextEventStored = async (eventId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);

  const mark = async () => {
    const record = await db.events.get(eventId);

    if (!record || record.bodyType !== "msg") throw new Error("RECEIVE_COMMIT_INCOMPLETE");
    await db.events.update(eventId, { applicationState: "stored" });
  };

  if (access) await writeVault(access, [db.events], mark);
  else await db.transaction("rw", db.events, mark);
};

/** Reuse the existing event row for authenticated application recovery, never a second queue. */
export const retainAuthenticatedApplication = async (record: EventRecord, body: unknown, access: VaultAccess) => {
  await access.assertMain();


  const authenticatedBody_enc = await encryptJsonRecord(access.key, record.eventId, `receive:${record.eventHash}`, body,
    record.envelopeFormat === "nkce-v1" ? "raw-v3" : undefined);

  if (record.envelopeFormat !== "nkce-v1") {
    await saveEvent({ ...record, applicationState: "pending", authenticatedBody_enc }, access);

    return;
  }

  const envelope = readEventEnvelope(record);

  if (await computeEnvelopeHash(envelope) !== record.eventHash || !record.localConvId) throw new Error("OWNER_EVENT_MISMATCH");
  const before = await access.db.events.get(record.eventId);
  await writeVault(access, [access.db.events], async () => {
    const current = await access.db.events.get(record.eventId);

    if (current && (current.applicationState === "stored" || current.envelopeFormat !== "nkce-v1" || current.eventHash !== record.eventHash ||
        current.localConvId !== record.localConvId || !samePayloadBytes(current.envelopeBytes, record.envelopeBytes)) ||
        !sameStoredCiphertext(current?.authenticatedBody_enc, before?.authenticatedBody_enc) || current?.applicationState !== before?.applicationState ||
        current?.applicationCryptoCommitted !== before?.applicationCryptoCommitted ||
        current?.ratchetCommitFingerprint !== before?.ratchetCommitFingerprint ||
        current?.ratchetCommitFingerprint && current.ratchetCommitFingerprint !== record.ratchetCommitFingerprint) {
      throw new Error("OWNER_EVENT_MISMATCH");
    }

    await access.db.events.put({ ...record, applicationState: "pending", authenticatedBody_enc,
      applicationCryptoCommitted: before?.applicationCryptoCommitted });
  });
};

export const readAuthenticatedApplication = async (record: EventRecord, access: VaultAccess) => {
  await access.assertMain();

  if (!record.authenticatedBody_enc) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
  const body = await decryptJsonRecord<unknown>(access.key, record.eventId, `receive:${record.eventHash}`, record.authenticatedBody_enc);
  access.assertLocal();

  return body;
};

/** Prepare encrypted text outside the short, conditional application commit. */
export const commitAuthenticatedText = async (envelope: Pick<Envelope, "header">, body: {
  text: string; media?: MediaRef; clientBatchId?: string; logicalProof?: LogicalMessage;
}, convId: string, senderId: string, reconnectRequired: boolean, eventHash: string, access: VaultAccess) => {
  await ensureVaultAccess(access);
  const db = access.db;
  const beforeEvent = await db.events.get(envelope.header.eventId);
  const beforeConv = await db.conversations.get(convId);

  if (!beforeEvent || beforeEvent.eventHash !== eventHash || beforeEvent.localConvId !== convId ||
      beforeEvent.bodyType !== "msg" || !beforeEvent.applicationCryptoCommitted || !beforeConv) {
    throw new Error("RECEIVE_COMMIT_INCOMPLETE");
  }

  const conv = await decryptJsonRecord<Conversation>(access.key, convId, "conv", beforeConv.enc_b64);
  const beforeSender = await db.profiles.get(senderId);
  const sender = beforeSender ? await decryptJsonRecord<UserProfile>(access.key, senderId, "profile", beforeSender.enc_b64) : undefined;

  if (!reconnectRequired && (conv.blocked || sender?.kind === "friend" && sender.friendStatus === "blocked")) {
    throw new Error("FRIEND_AUTHENTICATION_REQUIRED");
  }

  const built = buildReceivedText(conv, envelope, body.text, senderId, reconnectRequired);

  const message: Message = { ...built.message, id: body.logicalProof?.id ?? envelope.header.friendDeliveryId ?? built.message.id,
    ...(body.logicalProof?.groupId ? { ts: body.logicalProof.ts } : {}),
    media: body.media, clientBatchId: body.clientBatchId, ...(body.logicalProof ? { logicalProof: body.logicalProof } : {}) };

  const stableIntent = body.logicalProof || envelope.header.friendDeliveryId;
  const beforeMessage = stableIntent ? await db.messages.get(message.id) : undefined;

  if (beforeMessage) {
    const previous = await decryptJsonRecord<Message>(access.key, message.id, "message", beforeMessage.enc_b64);

    if (beforeMessage.convId !== convId || previous.senderId !== senderId || (body.logicalProof
        ? !previous.logicalProof || encodeBase64Url(canonicalBytes(previous.logicalProof)) !== encodeBase64Url(canonicalBytes(body.logicalProof))
        : Boolean(previous.logicalProof) || previous.text !== message.text ||
          encodeBase64Url(canonicalBytes({ media: previous.media, batch: previous.clientBatchId })) !==
          encodeBase64Url(canonicalBytes({ media: message.media, batch: message.clientBatchId })))) {
      throw new Error("LOGICAL_MESSAGE_CONFLICT");
    }
  }

  const [messageCiphertext, conversationCiphertext] = await Promise.all([
    encryptJsonRecord(access.key, message.id, "message", message, beforeEvent.envelopeFormat === "nkce-v1" ? "raw-v3" : undefined),
    encryptJsonRecord(access.key, convId, "conv", built.conversation),
  ]);

  return writeVault(access, [db.events, db.messages, db.conversations, db.profiles, db.meta], async () => {
    const event = await db.events.get(envelope.header.eventId);
    const existing = await db.messages.get(message.id);

    if (event?.eventHash !== eventHash || event.localConvId !== convId || !event.applicationCryptoCommitted) {
      throw new Error("RECEIVE_COMMIT_INCOMPLETE");
    }

    if (event.applicationState === "stored" && !event.authenticatedBody_enc && existing?.convId === convId) {
      return "duplicate" as const;
    }

    if (stableIntent && beforeMessage && sameStoredCiphertext(existing?.enc_b64, beforeMessage.enc_b64) &&
        event.applicationState === "pending" && sameStoredCiphertext(event.authenticatedBody_enc, beforeEvent.authenticatedBody_enc)) {
      await db.events.update(envelope.header.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `${LAMPORT_PREFIX}${envelope.header.convId}`;
      const current = Number((await db.meta.get(key))?.value ?? 0);
      await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, envelope.header.lamport)) });

      return "duplicate" as const;
    }

    if (!beforeEvent.authenticatedBody_enc || !sameStoredCiphertext(event.authenticatedBody_enc, beforeEvent.authenticatedBody_enc) || existing ||
        (await db.conversations.get(convId))?.enc_b64 !== beforeConv.enc_b64 ||
        (await db.profiles.get(senderId))?.enc_b64 !== beforeSender?.enc_b64) {
      throw new Error("OWNER_APPLICATION_CONFLICT");
    }

    await db.messages.add({ id: message.id, convId, ts: message.ts, enc_b64: messageCiphertext });
    await db.conversations.put({ id: convId, enc_b64: conversationCiphertext, updatedAt: Date.now() });
    await db.events.update(envelope.header.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
    const key = `${LAMPORT_PREFIX}${envelope.header.convId}`;
    const current = Number((await db.meta.get(key))?.value ?? 0);
    await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, envelope.header.lamport)) });

    return "stored" as const;
  });
};

/** Group effects and marker share the existing vault transaction; preparation never re-enters it. */
export const commitAuthenticatedGroup = async (envelope: Envelope, eventHash: string, conversation: Conversation,
  messages: Message[], previous: Conversation | null, access: VaultAccess,
  bindings: Array<{ id: string; identityPub: string }>, effectKey?: string) => {
  await access.assertMain();
  const db = access.db;
  const beforeEvent = await db.events.get(envelope.header.eventId);
  const beforeConv = await db.conversations.get(conversation.id);

  if (!beforeEvent?.authenticatedBody_enc || beforeEvent.eventHash !== eventHash ||
      !beforeEvent.applicationCryptoCommitted || beforeEvent.applicationState !== "pending" ||
      (beforeConv ? JSON.stringify(await decryptJsonRecord<Conversation>(access.key, beforeConv.id, "conv", beforeConv.enc_b64))
        !== JSON.stringify(previous) : previous !== null)) throw new Error("GROUP_APPLICATION_CONFLICT");
  const profileRows = await db.profiles.toArray();
  const profiles = await Promise.all(profileRows.map(row => decryptJsonRecord<UserProfile>(access.key, row.id, "profile", row.enc_b64)));

  for (const binding of bindings) {
    const profile = profiles.find(item => item.id === binding.id);

    if (!profile || (profile.kind !== "user" && (profile.identityPub !== binding.identityPub ||
        profile.friendStatus === "blocked" || profile.friendStatus === "deleted" ||
        profile.trust?.status === "blocked" || profile.trust?.status === "changed"))) throw new Error("GROUP_MEMBER_UNMAPPED");
  }

  const encryptedConversation = await encryptJsonRecord(access.key, conversation.id, "conv", conversation);

  const encryptedMessages = await Promise.all(messages.map(async message => ({ id: message.id, convId: message.convId,
    ts: message.ts, enc_b64: await encryptJsonRecord(access.key, message.id, "message", message) })));

  return writeVault(access, [db.events, db.profiles, db.conversations, db.messages, db.mediaChunks, db.meta], async () => {
    const event = await db.events.get(envelope.header.eventId);

    if (event?.eventHash !== eventHash || !sameStoredCiphertext(event.authenticatedBody_enc, beforeEvent.authenticatedBody_enc) ||
        !event.applicationCryptoCommitted || event.applicationState !== "pending" ||
        (await db.conversations.get(conversation.id))?.enc_b64 !== beforeConv?.enc_b64 ||
        JSON.stringify(await db.profiles.toArray()) !== JSON.stringify(profileRows)) throw new Error("GROUP_APPLICATION_CONFLICT");
    const repeated = effectKey && await db.meta.get(effectKey);

    if (!repeated) {
      await db.conversations.put({ id: conversation.id, enc_b64: encryptedConversation, updatedAt: Date.now() });

      if (previous?.sharedAvatarRef !== conversation.sharedAvatarRef) await db.mediaChunks.where("ownerId")
        .equals(conversation.id).and(chunk => chunk.ownerType === "group").delete();

      for (const record of encryptedMessages) {
        if (await db.messages.get(record.id)) throw new Error("GROUP_APPLICATION_CONFLICT");
        await db.messages.add(record);
      }

      if (effectKey) await db.meta.put({ key: effectKey, value: "stored" });
    }

    await db.events.update(event.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
    const key = `${LAMPORT_PREFIX}${envelope.header.convId}`;
    const current = Number((await db.meta.get(key))?.value ?? 0);
    await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, envelope.header.lamport)) });

    return true;
  });
};

export type AuthenticatedProfileApplication = {
  eventId: string; eventHash: string; convId: string; lamport: number; candidate: boolean;
};

/** Existing profile/conversation/avatar rows and their completion marker commit together. */
export const commitAuthenticatedProfile = async (profile: UserProfile | null, previous: UserProfile | null,
  application: AuthenticatedProfileApplication, access: VaultAccess,
  conversation?: Conversation, previousConversation?: Conversation | null, avatarFile?: File, deleted: Conversation[] = []) => {
  await access.assertMain();
  const db = access.db;
  const beforeProfile = profile ? await db.profiles.get(profile.id) : undefined;
  const beforeConversation = conversation ? await db.conversations.get(conversation.id) : undefined;
  const beforeEvent = application.candidate ? await db.events.get(application.eventId) : undefined;
  const markerKey = `friend_control_v1:${application.eventId}`;

  if ((beforeProfile && profile ? JSON.stringify(await decryptJsonRecord<UserProfile>(access.key, profile.id, "profile", beforeProfile.enc_b64)) !==
      JSON.stringify(previous) : previous !== null) ||
      (conversation && (beforeConversation ? JSON.stringify(await decryptJsonRecord<Conversation>(access.key, conversation.id, "conv", beforeConversation.enc_b64)) !==
      JSON.stringify(previousConversation) : previousConversation !== null)) ||
      (application.candidate && (!beforeEvent?.authenticatedBody_enc || beforeEvent.eventHash !== application.eventHash ||
        !beforeEvent.applicationCryptoCommitted || beforeEvent.applicationState !== "pending"))) throw new Error("PROFILE_APPLICATION_CONFLICT");
  const avatar = avatarFile && profile ? await prepareAvatarPhoto("profile", profile.id, avatarFile, access) : undefined;

  if (avatar && profile) profile = { ...profile, avatarRef: avatar.avatarRef,
    profileVcard: { ...profile.profileVcard, avatarRef: avatar.avatarRef } };
  const profileCiphertext = profile ? await encryptJsonRecord(access.key, profile.id, "profile", profile) : undefined;
  const convCiphertext = conversation ? await encryptJsonRecord(access.key, conversation.id, "conv", conversation) : undefined;

  const deletions = await Promise.all(deleted.map(async conv => {
    const record = await db.conversations.get(conv.id);

    if (!record || JSON.stringify(await decryptJsonRecord<Conversation>(access.key, conv.id, "conv", record.enc_b64)) !==
        JSON.stringify(conv)) throw new Error("PROFILE_APPLICATION_CONFLICT");
    const messages = await db.messages.where("convId").equals(conv.id).toArray();

    const messageIds = messages.map(message => message.id);

    const media = await db.mediaChunks.where("ownerId").anyOf([...messageIds, conv.id])
      .and(chunk => chunk.ownerType === "message" && messageIds.includes(chunk.ownerId) || chunk.ownerType === "group" && chunk.ownerId === conv.id).toArray();

    const indexes = await db.mediaIndex.where("convId").equals(conv.id).toArray();

    return { record, messages, media, indexes, wipedMessages: await prepareErasedMessages(messages, access),
      wipedMedia: await prepareErasedMediaChunks(media, access) };
  }));

  return writeVault(access, [db.profiles, db.conversations, db.messages, db.mediaChunks, db.mediaIndex,
    db.mediaPayloadChunks, db.mediaTransfers, db.receipts, db.outbox, db.events, db.meta, db.tombstones], async () => {
    if (!application.candidate && (await db.meta.get(markerKey))?.value === application.eventHash) return true;
    const candidate = application.candidate ? await db.events.get(application.eventId) : undefined;

    if ((profile && (await db.profiles.get(profile.id))?.enc_b64 !== beforeProfile?.enc_b64) ||
        (conversation && (await db.conversations.get(conversation.id))?.enc_b64 !== beforeConversation?.enc_b64) ||
        (application.candidate && (!sameStoredCiphertext(candidate?.authenticatedBody_enc, beforeEvent?.authenticatedBody_enc) ||
          candidate?.eventHash !== application.eventHash || candidate.applicationState !== "pending" || !candidate.applicationCryptoCommitted))) {
      throw new Error("PROFILE_APPLICATION_CONFLICT");
    }

    for (const deletion of deletions) {
      const id = deletion.record.id;

      if ((await db.conversations.get(id))?.enc_b64 !== deletion.record.enc_b64 ||
          JSON.stringify(await db.messages.where("convId").equals(id).toArray()) !== JSON.stringify(deletion.messages) ||
          JSON.stringify(await db.mediaChunks.where("ownerId").anyOf([...deletion.messages.map(message => message.id), id])
            .and(chunk => chunk.ownerType === "message" && deletion.messages.some(message => message.id === chunk.ownerId) || chunk.ownerType === "group" && chunk.ownerId === id).toArray()) !== JSON.stringify(deletion.media) ||
          JSON.stringify(await db.mediaIndex.where("convId").equals(id).toArray()) !== JSON.stringify(deletion.indexes)) throw new Error("PROFILE_APPLICATION_CONFLICT");
      await db.messages.bulkPut(deletion.wipedMessages);
      await db.messages.bulkDelete(deletion.messages.map(message => message.id));
      await db.mediaChunks.bulkPut(deletion.wipedMedia);
      await db.mediaChunks.bulkDelete(deletion.media.map(chunk => chunk.id));
      await db.mediaTransfers.bulkDelete(deletion.messages.map(message => message.id));
      await db.conversations.delete(id);
      await db.events.where("convId").equals(id).filter(event => event.eventId !== application.eventId).delete();
      await db.outbox.where("convId").equals(id).delete();
      await db.receipts.where("convId").equals(id).delete();
      await db.mediaIndex.where("convId").equals(id).delete();

      if (deletion.indexes.length) await db.mediaPayloadChunks.where("mediaId").anyOf(deletion.indexes.map(index => index.mediaId)).delete();
      await db.meta.delete(`${LAMPORT_PREFIX}${id}`);
      await db.tombstones.bulkPut([{ id, type: "conversation", deletedAt: Date.now() },
        ...deletion.messages.map(message => ({ id: message.id, type: "message", deletedAt: Date.now() }))]);
    }

    if (avatar && profile) {
      await db.mediaChunks.where("ownerId").equals(profile.id).and(chunk => chunk.ownerType === "profile").delete();
      await db.mediaChunks.bulkPut(avatar.records);
    }

    if (profile && profileCiphertext) await db.profiles.put({ id: profile.id, enc_b64: profileCiphertext, updatedAt: Date.now() });

    if (conversation && convCiphertext) await db.conversations.put({ id: conversation.id, enc_b64: convCiphertext, updatedAt: Date.now() });

    if (application.candidate) await db.events.update(application.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
    else await db.meta.put({ key: markerKey, value: application.eventHash });
    const key = `${LAMPORT_PREFIX}${application.convId}`;
    const current = Number((await db.meta.get(key))?.value ?? 0);
    await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, application.lamport)) });

    return true;
  });
};

export const listEventsByConv = async (convId: string, access?: VaultAccess, preparedEventIds?: ReadonlySet<string>) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  // Explicit history preparation may select chunk envelopes; ordinary scans still omit them.

  const rows = await db.events.where("convId").equals(convId)
    .filter(row => preparedEventIds ? preparedEventIds.has(row.eventId) : !row.ephemeralApplication).sortBy("lamport");

  access?.assertLocal();

  return rows;
};

export const getLastEventHash = async (convId: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);

  const record = await db.events
    .where("[convId+lamport]")
    .between([convId, Dexie.minKey], [convId, Dexie.maxKey])
    .filter(row => !row.ephemeralApplication)
    .reverse()
    .first();

  return record?.eventHash;
};

export const saveProfilePhoto = (ownerId: string, file: File, access?: VaultAccess) =>
  saveAvatarPhoto("profile", ownerId, file, access);

const prepareAvatarPhoto = async (ownerType: AvatarRef["ownerType"], ownerId: string, file: File, access?: VaultAccess) => {
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const metadata = await inspectAvatarImageFile(file);
  await assertAvatarPreviewBudget(file, metadata.mime);

  const buffer = await file.arrayBuffer();
  const chunks = chunkBuffer(buffer, MEDIA_CHUNK_SIZE);
  const total = chunks.length;
  const now = Date.now();
  const records: MediaChunkRecord[] = [];

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunkId = `${ownerId}:${idx}`;
    const enc_b64 = await encodeBinaryEnvelope(vk, chunkId, "mediaChunk", chunks[idx]);
    records.push({
      id: chunkId,
      ownerType,
      ownerId,
      idx,
      enc_b64,
      mime: metadata.mime,
      total,
      updatedAt: now,
    });

    if (shouldYieldMedia(idx, total)) {
      await yieldToEventLoop();
    }
  }

  const avatarRef: AvatarRef = {
    ownerType,
    ownerId,
    mime: metadata.mime,
    total,
    chunkSize: MEDIA_CHUNK_SIZE,
    revision: createId(),
    size: file.size,
  };

  return { avatarRef, records };
};

const saveAvatarPhoto = async (ownerType: AvatarRef["ownerType"], ownerId: string, file: File, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  access ??= (await captureLocalOperationContext())?.vault;

  if (!access || access.db !== db || generation !== getAccountOwnerGeneration() || db !== activeDb) {
    throw new Error("OWNER_SESSION_CHANGED");
  }

  const { avatarRef, records } = await prepareAvatarPhoto(ownerType, ownerId, file, access);
  await writeVault(access, [db.mediaChunks], async () => {
    await db.mediaChunks.where("ownerId").equals(ownerId).and(chunk => chunk.ownerType === ownerType).delete();
    await db.mediaChunks.bulkPut(records);
  });

  return avatarRef;
};

export const saveGroupPhotoRef = async (ownerId: string, file: File, access?: VaultAccess) => {
  const avatarRef = await saveAvatarPhoto("group", ownerId, file, access);

  return serializeAvatarRef(avatarRef);
};

export const loadProfilePhoto = async (avatarRef?: AvatarRef, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();

  try {
    await ensureVaultAccess(access);
    access ??= (await captureLocalOperationContext())?.vault;

    if (!access || access.db !== db || generation !== getAccountOwnerGeneration() || db !== activeDb) return null;

    if (!avatarRef) return null;
    const vk = requireVaultKey(access);
    const ownerType = avatarRef.ownerType === "group" ? "group" : "profile";

    const chunks = await db.mediaChunks
      .where("ownerId")
      .equals(avatarRef.ownerId)
      .and((chunk) => chunk.ownerType === ownerType)
      .sortBy("idx");

    if (!chunks.length) return null;

    if (!Number.isFinite(avatarRef.total) || avatarRef.total <= 0) return null;

    if (!Number.isFinite(avatarRef.chunkSize) || avatarRef.chunkSize <= 0) return null;

    if (chunks.length !== avatarRef.total) return null;

    if (avatarRef.total * avatarRef.chunkSize > MAX_MEDIA_BYTES) return null;

    const decrypted = await decryptMediaChunks(vk, chunks);

    if (decrypted.length !== chunks.length) return null;
    const totalBytes = decrypted.reduce((sum, part) => sum + part.length, 0);

    if (totalBytes > MAX_MEDIA_BYTES) return null;
    const blob = new Blob(decrypted, { type: avatarRef.mime });
    await assertAvatarPreviewBudget(blob, avatarRef.mime);

    await access.assertMain();

    if (generation !== getAccountOwnerGeneration() || db !== activeDb || getVaultKey() !== vk) return null;

    return blob;
  } catch {
    return null;
  }
};

export const loadAvatarFromRef = async (ref?: string | null, access?: VaultAccess) => {
  const parsed = parseAvatarRef(ref);

  if (!parsed) return null;

  return loadProfilePhoto(parsed, access);
};

export const saveMessageMedia = async (
  messageId: string,
  file: File,
  chunkSize = MEDIA_CHUNK_SIZE,
  onStoredChunk?: (chunk: MessageMediaChunk) => Promise<void>,
  preparedMetadata?: PreparedMediaMetadata, access?: VaultAccess
) => {
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);

  const assertOwner = () => {
    access?.assertLocal();

    if (generation !== getAccountOwnerGeneration() || db !== activeDb || getVaultKey() !== vk) throw new Error("OWNER_SESSION_CHANGED");
  };

  assertOwner();

  if (!Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize > MAX_MEDIA_CHUNK_SIZE) {
    throw new Error("Invalid media chunk size");
  }

  if (file.size <= 0 || file.size > MAX_MEDIA_BYTES) {
    throw new Error("Invalid media size");
  }

  const metadata = preparedMetadata ?? await inspectOutgoingMediaFile(file);
  assertOwner();
  const mediaRef = createMessageMediaRef(messageId, file, chunkSize, metadata);
  const sourceMessage = await db.messages.get(messageId);

  if (await db.tombstones.get(messageId)) throw new Error("MEDIA_SOURCE_DELETED");

  if (!sourceMessage) throw new Error("MEDIA_MANIFEST_UNAVAILABLE");
  const source = await decryptJsonRecord<Message>(vk, messageId, "message", sourceMessage.enc_b64);
  const manifest = parseIncomingMediaRef(source.media, messageId);

  if (source.id !== messageId || !manifest || manifest.ownerType !== "message" ||
      manifest.total !== mediaRef.total || manifest.chunkSize !== mediaRef.chunkSize || manifest.size !== mediaRef.size ||
      manifest.mime !== mediaRef.mime || manifest.name !== mediaRef.name) throw new Error("MEDIA_CHUNK_CONFLICT");
  await writeVault(access, [db.mediaChunks, db.messages, db.tombstones, db.meta], async () => {
    if (await db.meta.get(mediaCustodyKey(messageId))) throw new Error("MEDIA_CONVERSION_IN_PROGRESS");

    if (await db.tombstones.get(messageId) || !sameStoredCiphertext((await db.messages.get(messageId))?.enc_b64, sourceMessage.enc_b64)) throw new Error("MEDIA_SOURCE_DELETED");
    await db.mediaChunks
    .where("ownerId")
    .equals(messageId)
    .and((chunk) => chunk.ownerType === "message")
    .delete();
  });
  const total = mediaRef.total;
  const now = Date.now();
  const records: MediaChunkRecord[] = [];

  const flushRecords = async () => {
    if (!records.length) return;
    assertOwner();
    await db.transaction("rw", [db.mediaChunks, db.messages, db.tombstones, db.meta], () =>
      writeVault(access, [db.mediaChunks, db.messages, db.tombstones, db.meta], async () => {
        if (await db.meta.get(mediaCustodyKey(messageId))) throw new Error("MEDIA_CONVERSION_IN_PROGRESS");

        if (await db.tombstones.get(messageId) || !sameStoredCiphertext((await db.messages.get(messageId))?.enc_b64, sourceMessage?.enc_b64)) throw new Error("MEDIA_SOURCE_DELETED");
        await db.mediaChunks.bulkPut(records.splice(0));
      })
    );

    assertOwner();
  };

  for (let idx = 0; idx < total; idx += 1) {
    const start = idx * chunkSize;

    const bytes = new Uint8Array(
      await file.slice(start, Math.min(file.size, start + chunkSize)).arrayBuffer()
    );

    const chunkId = `${messageId}:${idx}`;

    const enc_b64 = await encodeBinaryEnvelope(
      vk,
      chunkId,
      "mediaChunk",
      bytes
    );

    records.push({
      id: chunkId,
      ownerType: "message",
      ownerId: messageId,
      idx,
      enc_b64,
      mime: mediaRef.mime,
      total,
      updatedAt: now,
    });

    if (records.length >= MEDIA_WRITE_BATCH_SIZE) {
      await flushRecords();
    }

    if (shouldYieldMedia(idx, total)) {
      await yieldToEventLoop();
    }
  }

  await flushRecords();

  assertOwner();
  notifyMessageMediaReady(messageId);

  // Network failure must not interrupt persistence of the remaining original file.
  if (onStoredChunk) for await (const chunk of readMessageMediaChunks(mediaRef, access)) await onStoredChunk(chunk);

  assertOwner();

  return mediaRef;
};

export async function* readMessageMediaChunks(mediaRef: MediaRef, access?: VaultAccess, startIdx = 0): AsyncGenerator<MessageMediaChunk> {
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);

  const assertOwner = () => {
    access?.assertLocal();

    if (generation !== getAccountOwnerGeneration() || db !== activeDb || getVaultKey() !== vk) throw new Error("OWNER_SESSION_CHANGED");
  };

  assertOwner();
  const validated = parseIncomingMediaRef(mediaRef, mediaRef.ownerId);

  if (!validated || mediaRef.ownerType !== "message") throw new Error("MEDIA_MANIFEST_UNAVAILABLE");

  if (!Number.isSafeInteger(startIdx) || startIdx < 0 || startIdx >= validated.total) throw new Error("MEDIA_CHUNK_CONFLICT");
  const custody = await readMediaCustody(validated.ownerId, db, vk);
  assertOwner();

  if (custody?.phase === "plaintext") {
    access ??= (await captureLocalOperationContext())?.vault;
    const read = typeof window !== "undefined" ? window.nkc?.permanentMedia : undefined;

    if (!access || !read || access.db !== db || access.key !== vk || custody.media.size !== validated.size ||
        custody.media.mime !== validated.mime || custody.media.total !== validated.total ||
        custody.media.chunkSize !== validated.chunkSize) throw new Error("MEDIA_CUSTODY_INVALID");

    for (let idx = startIdx; idx < validated.total; idx++) {
      await access.assertMain();
      assertOwner();
      const length = Math.min(validated.chunkSize, validated.size - idx * validated.chunkSize);
      const result = await read(access.session, { operation: "read", token: custody.token, offset: idx * validated.chunkSize, length });
      await access.assertMain();
      assertOwner();

      if (!(result.bytes instanceof Uint8Array) || result.bytes.length !== length) throw new Error("MEDIA_FILE_CHANGED");
      yield { idx, total: validated.total, bytes: result.bytes };
      assertOwner();
    }

    return;
  }

  for (let idx = startIdx; idx < validated.total; idx++) {
    await ensureVaultAccess(access);
    assertOwner();
    const chunkId = `${validated.ownerId}:${idx}`;
    const row = await db.mediaChunks.get(chunkId);
    assertOwner();

    if (!row || row.ownerType !== "message" || row.ownerId !== validated.ownerId || row.idx !== idx || row.total !== validated.total ||
        normalizeMediaMime(row.mime) !== validated.mime) throw new Error("MEDIA_CHUNK_CONFLICT");
    const bytes = new Uint8Array(await decodeBinaryEnvelope(vk, chunkId, "mediaChunk", row.enc_b64));
    await access?.assertMain();
    assertOwner();

    if (bytes.length !== Math.min(validated.chunkSize, validated.size - idx * validated.chunkSize)) throw new Error("MEDIA_CHUNK_CONFLICT");
    yield { idx, total: validated.total, bytes };
    assertOwner();
  }
}

export const saveReceivedMessageMediaChunk = async (input: {
  ownerId: string;
  idx: number;
  total: number;
  chunkSize: number;
  size: number;
  mime: string;
  bytes: Uint8Array;
  ownerType?: "message" | "group"; revision?: string;
}, access?: VaultAccess, application?: {
  envelope: Envelope; eventHash: string; authenticatedIdentity: string; localUserId: string; validateOnly?: boolean;
  logicalProof?: LogicalMediaChunk;
}) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const ownerId = input.ownerId.trim();

  if (!isValidMediaOwnerId(ownerId)) throw new Error("Invalid media owner");

  if (!Number.isInteger(input.idx) || input.idx < 0) throw new Error("Invalid media chunk index");

  if (!Number.isInteger(input.total) || input.total <= 0) throw new Error("Invalid media chunk total");

  if (input.idx >= input.total) throw new Error("Invalid media chunk index");

  if (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0 || input.chunkSize > MAX_MEDIA_CHUNK_SIZE) {
    throw new Error("Invalid media chunk size");
  }

  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_MEDIA_BYTES) {
    throw new Error("Invalid media size");
  }

  if (input.total * input.chunkSize > MAX_MEDIA_BYTES + input.chunkSize) {
    throw new Error("Media exceeds size limit");
  }

  if (input.bytes.byteLength <= 0 || input.bytes.byteLength > input.chunkSize) {
    throw new Error("Invalid media chunk payload");
  }

  if (input.total !== Math.ceil(input.size / input.chunkSize)) {
    throw new Error("Invalid media chunk total");
  }

  const expectedChunkBytes = input.idx === input.total - 1
    ? input.size - input.chunkSize * (input.total - 1)
    : input.chunkSize;

  if (input.bytes.byteLength !== expectedChunkBytes) {
    throw new Error("Invalid media chunk payload length");
  }

  const mime = normalizeMediaMime(input.mime);

  if (isPreviewMediaClaim(input.mime) && !isSafePreviewMime(mime)) {
    throw new Error("Unsupported media preview type");
  }

  if (input.idx === 0 && isSafePreviewMime(mime) && !hasValidPreviewSignature(mime, input.bytes)) {
    throw new Error("Media content does not match its declared type");
  }

  const ownerType = input.ownerType ?? "message";
  const manifestRecord = ownerType === "group" ? await db.conversations.get(ownerId) : await db.messages.get(ownerId);

  if (!manifestRecord) throw new Error("Media manifest is missing");
  const profiles = application ? await db.profiles.toArray() : [];
  const readableProfiles = await Promise.all(profiles.map(row => decryptJsonRecord<UserProfile>(vk, row.id, "profile", row.enc_b64)));

  const actors = readableProfiles.filter(profile => profile.kind === "friend" && profile.identityPub === application?.authenticatedIdentity &&
    profile.friendStatus !== "blocked" && profile.friendStatus !== "deleted" && profile.trust?.status !== "blocked" && profile.trust?.status !== "changed");

  const owner = ownerType === "group" ? await decryptJsonRecord<Conversation>(vk, ownerId, "conv", manifestRecord.enc_b64) :
    await decryptJsonRecord<Message>(vk, ownerId, "message", manifestRecord.enc_b64);

  const group = owner as Conversation;
  const avatar = ownerType === "group" ? parseAvatarRef(group.sharedAvatarRef) : undefined;
  const logical = application?.logicalProof;
  const logicalOwner = (owner as Message).logicalProof;
  const ownRoot = logical ? (await db.meta.get("nkc_account_root_v1"))?.value : undefined;

  const localActor = logical && logical.senderAccountIdentity === ownRoot ?
    readableProfiles.find(profile => profile.kind === "user" && profile.id === application!.localUserId) : actors[0];

  if (logical && (ownerType !== "message" || !logicalOwner || !localActor ||
      (owner as Message).senderId !== localActor.id || logical.messageId !== ownerId ||
      logical.conversationIdentity !== logicalOwner.conversationIdentity || logical.groupId !== logicalOwner.groupId ||
      logical.senderAccountIdentity !== logicalOwner.senderAccountIdentity || logical.recipientAccountIdentity !== logicalOwner.recipientAccountIdentity ||
      logical.author.deviceId !== logicalOwner.author.deviceId || logical.author.identityPub !== logicalOwner.author.identityPub ||
      logical.idx !== input.idx || logical.total !== input.total || logical.size !== input.size ||
      logical.chunkSize !== input.chunkSize || logical.mime !== mime)) throw new Error("MEDIA_OWNER_MISMATCH");

  if (application && !logical && (actors.length !== 1 || (ownerType === "group" ?
      group.type !== "group" || !group.participants.includes(actors[0].id) || !group.participants.includes(application.localUserId) ||
      group.sharedAvatarAuthorIdentityPub !== application.authenticatedIdentity || !avatar?.revision || avatar.revision !== input.revision :
      (owner as Message).senderId !== actors[0].id))) throw new Error("MEDIA_OWNER_MISMATCH");

  if (ownerType === "group" && (!application || !avatar || input.size > 10 * 1024 * 1024)) throw new Error("MEDIA_OWNER_MISMATCH");
  const manifest = ownerType === "group" ? avatar : parseIncomingMediaRef((owner as Message).media, ownerId);

  if (
    !manifest ||
    manifest.total !== input.total ||
    manifest.chunkSize !== input.chunkSize ||
    manifest.size !== input.size ||
    manifest.mime !== mime
  ) {
    throw new Error("Media chunk does not match its authenticated manifest");
  }

  const existing = await db.mediaChunks
    .where("ownerId")
    .equals(ownerId)
    .and((chunk) => chunk.ownerType === ownerType)
    .first();

  if (existing && (existing.total !== input.total || normalizeMediaMime(existing.mime) !== mime)) {
    throw new Error("Inconsistent media metadata");
  }

  const chunkId = `${ownerId}:${input.idx}`;
  const previousChunk = await db.mediaChunks.get(chunkId);
  const previousBytes = previousChunk ? new Uint8Array(await decodeBinaryEnvelope(vk, chunkId, "mediaChunk", previousChunk.enc_b64)) : undefined;

  if (previousChunk && (previousChunk.ownerType !== ownerType || previousChunk.total !== input.total || previousChunk.mime !== mime ||
      previousBytes?.length !== input.bytes.length || !previousBytes.every((byte, index) => byte === input.bytes[index]))) {
    throw new Error("MEDIA_CHUNK_CONFLICT");
  }

  if (application?.validateOnly) {
    access?.assertLocal();

    return { received: previousChunk ? 1 : 0, total: input.total, complete: false };
  }

  const beforeEvent = application ? await db.events.get(application.envelope.header.eventId) : undefined;

  if (application && (!beforeEvent?.authenticatedBody_enc || beforeEvent.eventHash !== application.eventHash ||
      !beforeEvent.applicationCryptoCommitted || beforeEvent.applicationState !== "pending")) throw new Error("MEDIA_APPLICATION_CONFLICT");
  const enc_b64 = await encodeBinaryEnvelope(vk, chunkId, "mediaChunk", input.bytes);
  const logicalProof_enc = logical ? await encryptJsonRecord(vk, chunkId, "media-proof", logical) : undefined;
  await writeVault(access, application ? [db.mediaChunks, db.conversations, db.messages, db.profiles, db.events, db.meta] : [db.mediaChunks, db.conversations, db.messages, db.meta], async () => {
    if (ownerType === "message" && await db.meta.get(mediaCustodyKey(ownerId))) throw new Error("MEDIA_CONVERSION_IN_PROGRESS");
    const currentManifest = ownerType === "group" ? await db.conversations.get(ownerId) : await db.messages.get(ownerId);

    if (!sameStoredCiphertext(currentManifest?.enc_b64, manifestRecord.enc_b64)) throw new Error("MEDIA_APPLICATION_CONFLICT");

    if (application) {
      const event = await db.events.get(application.envelope.header.eventId);

      if (!sameStoredCiphertext(event?.authenticatedBody_enc, beforeEvent?.authenticatedBody_enc) || event?.eventHash !== application.eventHash ||
          event?.applicationState !== "pending" || !event.applicationCryptoCommitted || !sameStoredCiphertext(currentManifest?.enc_b64, manifestRecord.enc_b64) ||
          JSON.stringify(await db.profiles.toArray()) !== JSON.stringify(profiles) ||
          (await db.mediaChunks.get(chunkId))?.enc_b64 !== previousChunk?.enc_b64) throw new Error("MEDIA_APPLICATION_CONFLICT");
    }

    if (!previousChunk) await db.mediaChunks.add({ id: chunkId, ownerType, ownerId, idx: input.idx,
      enc_b64, mime, total: input.total, updatedAt: Date.now(), ...(logicalProof_enc ? { logicalProof_enc } : {}) });
    else if (logicalProof_enc && !previousChunk.logicalProof_enc) await db.mediaChunks.update(chunkId, { logicalProof_enc });

    if (application) {
      await db.events.update(application.envelope.header.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `${LAMPORT_PREFIX}${application.envelope.header.convId}`;
      const current = Number((await db.meta.get(key))?.value ?? 0);
      await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, application.envelope.header.lamport)) });
    }
  });

  const received = await db.mediaChunks
    .where("ownerId")
    .equals(ownerId)
    .and((chunk) => chunk.ownerType === ownerType)
    .count();

  const complete = received === input.total;

  if (complete && ownerType === "message") notifyMessageMediaReady(ownerId);

  return { received, total: input.total, complete };
};

export const loadMessageMedia = async (mediaRef?: MediaRef, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();

  try {
    await ensureVaultAccess(access);
    access ??= (await captureLocalOperationContext())?.vault;

    if (!access || access.db !== db || generation !== getAccountOwnerGeneration() || db !== activeDb) return null;

    if (!mediaRef) return null;
    const validatedRef = parseIncomingMediaRef(mediaRef, mediaRef.ownerId);

    if (!validatedRef) return null;
    const vk = requireVaultKey(access);
    const custody = await readMediaCustody(validatedRef.ownerId, db, vk);

    if (custody?.phase === "plaintext") {
      const parts: Uint8Array<ArrayBuffer>[] = [];

      for await (const chunk of readMessageMediaChunks(mediaRef, access)) parts.push(new Uint8Array(chunk.bytes));

      if (isPreviewMediaClaim(validatedRef.mime) && !hasValidPreviewSignature(validatedRef.mime, parts[0] ?? new Uint8Array())) return null;
      const blob = new Blob(parts, { type: validatedRef.mime });

      await access.assertMain();

      if (generation !== getAccountOwnerGeneration() || db !== activeDb || getVaultKey() !== vk) return null;

      return blob;
    }

    const chunks = await db.mediaChunks
      .where("ownerId")
      .equals(mediaRef.ownerId)
      .and((chunk) => chunk.ownerType === "message")
      .sortBy("idx");

    if (!chunks.length) return null;

    if (chunks.length !== validatedRef.total) return null;

    if (chunks.some((chunk, index) =>
      chunk.idx !== index ||
      chunk.total !== validatedRef.total ||
      normalizeMediaMime(chunk.mime) !== validatedRef.mime
    )) return null;

    const decrypted = await decryptMediaToBlob(vk, chunks, validatedRef.mime, MAX_MEDIA_BYTES);

    if (!decrypted) return null;

    if (decrypted.totalBytes !== validatedRef.size) return null;

    await access.assertMain();

    if (generation !== getAccountOwnerGeneration() || db !== activeDb || getVaultKey() !== vk) return null;

    return decrypted.blob;
  } catch {
    return null;
  }
};

export const seedVaultData = async (user: UserProfile, access?: VaultAccess) => {
  await ensureVaultAccess(access);
  const now = Date.now();

  const friends: UserProfile[] = [
    {
      id: createId(),
      displayName: "테스트 친구",
      status: "NKC 테스트 중",
      theme: "dark",
      kind: "friend",
      friendStatus: "normal",
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: createId(),
      displayName: "민지",
      status: "온라인",
      theme: "dark",
      kind: "friend",
      friendStatus: "normal",
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: createId(),
      displayName: "리드",
      status: "업무 중",
      theme: "dark",
      kind: "friend",
      friendStatus: "normal",
      verification: { status: "verified", verifiedAt: now },
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: createId(),
      displayName: "진아",
      status: "자리 비움",
      theme: "dark",
      kind: "friend",
      friendStatus: "normal",
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  await saveProfile(user, access);

  for (const friend of friends) {
    await saveProfile(friend, access);
  }

  const conversationEntries = Array.from({ length: 10 }).map((_, idx) => {
    const friend = friends[idx % friends.length];
    const isTestFriend = friend.displayName === "테스트 친구";
    const isPinned = idx < 2 || isTestFriend;
    const id = createId();

    return {
      conv: {
        id,
        name: `${friend.displayName} 대화 ${idx + 1}`,
        pinned: isPinned,
        unread: idx % 3 === 0 ? 2 : 0,
        hidden: false,
        muted: idx % 4 === 0,
        blocked: false,
        lastTs: Date.now() - idx * 1000 * 60 * 9,
        lastMessage: isTestFriend
          ? "테스트 대화가 준비되어 있습니다."
          : "로컬-퍼스트 채팅을 준비하고 있어요.",
        participants: [user.id, friend.id],
      },
      friend,
      idx,
    };
  });

  const conversations = conversationEntries.map((entry) => entry.conv);

  for (const entry of conversationEntries) {
    const { conv, friend } = entry;
    await saveConversation(conv, access);
    const isTestFriend = friend.displayName === "테스트 친구";

    const customMessages = [
      "안녕하세요! 테스트용 채팅입니다.",
      "프로필/정보 패널 표시를 확인하고 있어요.",
      "미디어 탭에는 추후 파일 미리보기가 들어옵니다.",
      "설정 탭에서 알림/차단/음소거를 제어할 수 있어요.",
      "여기까지가 테스트 시나리오입니다.",
    ];

    const messages: Message[] = Array.from({ length: 20 }).map((_, mIdx) => {
      const senderId = mIdx % 2 === 0 ? user.id : conv.participants[1];

      const text = isTestFriend
        ? customMessages[mIdx % customMessages.length]
        : mIdx % 2 === 0
          ? "로컬에서 안전하게 저장됩니다."
          : "좋아요, 계속 진행해요.";

      return {
        id: createId(),
        convId: conv.id,
        senderId,
        text,
        ts: conv.lastTs - (20 - mIdx) * 1000 * 60,
      };
    });

    for (const message of messages) {
      await saveMessage(message, access);
    }
  }

  return { friends, conversations };
};

export const rotateVaultKeys = async (
  newStartKey: string,
  onProgress?: (value: number) => void, access?: VaultAccess
) => {
  if (!access) throw new Error("VAULT_ROTATION_OWNER_REQUIRED");
  const db = access.db;
  await ensureVaultAccess(access);
  const oldVk = requireVaultKey(access);
  const newHeader = await createVaultHeader();
  const newMkm = await deriveMkm(newStartKey, newHeader);
  const newVk = await deriveVk(newMkm);

  const tables = [db.profiles, db.conversations, db.messages, db.mediaChunks, db.events,
    db.receipts, db.outbox, db.mediaTransfers, db.meta];

  const commits: Array<() => Promise<void>> = [];

  const reencrypt = async (id: string, type: string, value: string) =>
    encryptJsonRecord(newVk, id, type, await decryptJsonRecord<unknown>(oldVk, id, type, value));

  const reencryptPayload = async (id: string, type: string, value: string | Uint8Array) =>
    value instanceof Uint8Array
      ? encodeBinaryEnvelope(newVk, id, type, await decodeBinaryEnvelope(oldVk, id, type, value), "raw-v3")
      : reencrypt(id, type, value);

  const prepare = async <T extends object>(table: import("dexie").Table<T, string>, update: (row: T) => Promise<T>) => {
    const before = await table.toArray();
    const after: T[] = [];

    // ponytail: ciphertext preparation is linear in vault size; large-vault rotation needs a reviewed bounded staging contract.
    for (const row of before) { access?.assertLocal(); after.push(await update(row)); }

    commits.push(async () => {
      const current = await table.toArray();

      if (current.length !== before.length || current.some((row, index) => {
        const expected = new Map<string, unknown>(Object.entries(before[index]));
        const fields: Array<[string, unknown]> = Object.entries(row);

        return fields.length !== expected.size || fields.some(([name, value]) => {
          const previous = expected.get(name);

          if (!expected.has(name)) return true;


          if (value instanceof Uint8Array || previous instanceof Uint8Array) {
            return !(value instanceof Uint8Array && previous instanceof Uint8Array) || !sameStoredCiphertext(value, previous);
          }

          return JSON.stringify(value) !== JSON.stringify(previous);
        });
      })) throw new Error("VAULT_ROTATION_CONFLICT");

      if (after.length) await table.bulkPut(after);
    });
  };

  try {
    await prepare(db.profiles, async row => ({ ...row, enc_b64: await reencrypt(row.id, "profile", row.enc_b64) }));
    await prepare(db.conversations, async row => ({ ...row, enc_b64: await reencrypt(row.id, "conv", row.enc_b64) }));
    await prepare(db.messages, async row => ({ ...row, enc_b64: await reencryptPayload(row.id, "message", row.enc_b64) }));
    await prepare(db.mediaChunks, async row => ({ ...row,
      enc_b64: await encodeBinaryEnvelope(newVk, row.id, "mediaChunk", await decodeBinaryEnvelope(oldVk, row.id, "mediaChunk", row.enc_b64)),
      ...(row.logicalProof_enc ? { logicalProof_enc: await reencrypt(row.id, "media-proof", row.logicalProof_enc) } : {}) }));
    await prepare(db.events, async row => {
      const next = { ...row };

      if (row.authenticatedBody_enc) next.authenticatedBody_enc = await reencryptPayload(row.eventId, `receive:${row.eventHash}`, row.authenticatedBody_enc);

      if (row.outgoingBody_enc) next.outgoingBody_enc = await reencrypt(row.eventId, `outgoing:${row.eventHash}`, row.outgoingBody_enc);

      if (row.mediaReceipt_enc) next.mediaReceipt_enc = await reencrypt(row.eventId, "media-receipt", row.mediaReceipt_enc);

      if (row.envelopeFormat === "nkce-v1") return next;
      const body = JSON.parse(legacyEventJson(row));

      if (body?.v === 2 && typeof body.authorization_enc === "string") next.envelopeJson = JSON.stringify({ ...body,
        authorization_enc: await reencrypt(row.eventId, "device-authorization", body.authorization_enc) });

      return next;
    });
    await prepare(db.receipts, async row => ({ ...row, ...(row.logicalRead_enc ? {
      logicalRead_enc: await reencrypt(row.id, "receipt", row.logicalRead_enc) } : {}), ...(row.logicalDelivered_enc ? {
      logicalDelivered_enc: await reencrypt(row.id, "receipt", row.logicalDelivered_enc) } : {}) }));
    await prepare(db.outbox, async row => {
      const next = { ...row };

      if (row.nativeRoute_enc) next.nativeRoute_enc = await reencrypt(row.id, "native-handoff-v1", row.nativeRoute_enc);

      if (row.payloadFormat === "nkcp-v2") return next;
      let wrapped = false;
      const ciphertext = legacyOutboxCiphertext(row);

      try { wrapped = JSON.parse(atob(ciphertext))?.aad?.schema === "NKC"; } catch { /* Ordinary wire ciphertext is unchanged. */ }

      if (wrapped) next.ciphertext = await reencrypt(row.id, "outbox", ciphertext);

      return next;
    });
    await prepare(db.mediaTransfers, async row => ({ ...row, enc_b64: await reencrypt(row.transferId, "mediaTransfer", row.enc_b64) }));
    const beforeMeta = await db.meta.toArray();
    const afterMeta = new Map(beforeMeta.map(row => [row.key, row.value]));

    for (const row of beforeMeta) {
      if (row.key.startsWith("media-custody:v1:")) afterMeta.set(row.key, await reencrypt(row.key, "media-custody", row.value));

      if (row.key.startsWith("fresh_intent_v1:")) afterMeta.set(row.key, await reencrypt(row.key, "fresh-intent", row.value));

      if (row.key.startsWith("phase2h:channel:")) afterMeta.set(row.key, await reencrypt(row.key, "unified-ratchet-v1", row.value));

      if (row.key.startsWith("phase2h:outbound:")) afterMeta.set(row.key, await reencrypt(row.key, "unified-outbox-v1", row.value));
    }

    const registry = afterMeta.get("nkc_device_registry_v2");

    if (registry) {
      const value = JSON.parse(registry);

      if (value?.v === 3) afterMeta.set("nkc_device_registry_v2", JSON.stringify({ ...value,
        enc_b64: await reencrypt("nkc_device_registry_v2", "device-registry", value.enc_b64) }));
    }

    afterMeta.set(VAULT_META_KEY, JSON.stringify(newHeader));
    const keyId = await computeVaultKeyId(newVk);

    if (!keyId) throw new Error("VAULT_KEY_ID_UNAVAILABLE");
    afterMeta.set(VAULT_KEY_ID_KEY, keyId);
    await writeVault(access, tables, async () => {
      if (JSON.stringify(await db.meta.toArray()) !== JSON.stringify(beforeMeta)) throw new Error("VAULT_ROTATION_CONFLICT");

      for (const commit of commits) await commit();
      await db.meta.bulkPut([...afterMeta].map(([key, value]) => ({ key, value })));
    }, access?.authorizationMeta ? afterMeta.get(access.authorizationMeta.key) : undefined);
    setVaultKey(newVk);
    onProgress?.(100);
  } finally { newMkm.fill(0); newVk.fill(0); }
};

export const resetVaultStorage = async () => {
  clearVaultKey();
  await resetDb();
};

export const wipeVault = async (dbName = activeDb.name) => {
  clearVaultKey();
  await deleteVaultDatabase(dbName);
};

export type VaultUsage = {
  bytes: number;
  breakdown: {
    profiles: number;
    conversations: number;
    messages: number;
    media: number;
    outbox: number;
    meta: number;
  };
};

const sizeOfString = (value?: string | Uint8Array | null) => value instanceof Uint8Array ? value.byteLength : value?.length ?? 0;

export const getVaultUsage = async (access?: VaultAccess): Promise<VaultUsage> => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const profiles = await db.profiles.toArray();
  const conversations = await db.conversations.toArray();
  const messages = await db.messages.toArray();
  const media = await db.mediaChunks.toArray();
  const outbox = db.outbox ? await db.outbox.toArray() : [];
  const meta = await db.meta.toArray();

  const breakdown = {
    profiles: profiles.reduce((sum, record) => sum + sizeOfString(record.enc_b64), 0),
    conversations: conversations.reduce((sum, record) => sum + sizeOfString(record.enc_b64), 0),
    messages: messages.reduce((sum, record) => sum + sizeOfString(record.enc_b64), 0),
    media: media.reduce((sum, record) => sum + sizeOfString(record.enc_b64), 0),
    outbox: outbox.reduce((sum, record) => sum + (record.payloadFormat === "nkcp-v2"
      ? record.payloadBytes.byteLength : sizeOfString(record.ciphertext)), 0),
    meta: meta.reduce((sum, record) => sum + sizeOfString(record.value), 0),
  };

  return {
    bytes:
      breakdown.profiles +
      breakdown.conversations +
      breakdown.messages +
      breakdown.media +
      breakdown.outbox +
      breakdown.meta,
    breakdown,
  };
};

type DecryptedOutboxRecord = OutboxItem & { payload: OutboxPayload };

export const enqueueOutbox = async (item: OutboxItem, payload: Uint8Array, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);
  const payloadB64u = encodeBase64Url(payload);

  const ciphertext = await encryptJsonRecord(vk, item.id, "outbox", {
    ...item,
    payload: { payloadB64u },
  } satisfies DecryptedOutboxRecord);

  const record: OutboxRecord = {
    ...item,
    lastError: item.lastError ?? "",
    ciphertext,
    createdAtMs: item.createdAt,
    expiresAtMs: item.createdAt + item.ttlMs,
    nextAttemptAtMs: item.nextAttemptAt,
    attempts: item.attempt,
    status: "pending",
  };

  await writeVault(access, [db.outbox], () => db.outbox.put(record));
};

export const listDueOutboxByConv = async (convId: string, now: number, limit = 10, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const vk = requireVaultKey(access);

  const records = await db.outbox
    .where("[convId+nextAttemptAt]")
    .between([convId, Dexie.minKey], [convId, now], true, true)
    .limit(limit)
    .toArray();

  const decoded = await Promise.all(
    records.map(async (record) => {
      const item = await decryptJsonRecord<DecryptedOutboxRecord>(
        vk,
        record.id,
        "outbox",
        legacyOutboxCiphertext(record)
      );

      const meta: OutboxItem = {
        id: record.id,
        convId: record.convId,
        createdAt: record.createdAt ?? item.createdAt,
        ttlMs: record.ttlMs ?? item.ttlMs,
        attempt: record.attempt ?? item.attempt,
        nextAttemptAt: record.nextAttemptAt ?? item.nextAttemptAt,
        lastError: record.lastError || undefined,
      };

      return {
        meta,
        payload: decodeBase64Url(item.payload.payloadB64u),
      };
    })
  );

  return decoded;
};

export const markOutboxRetry = async (id: string, err: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const record = await db.outbox.get(id);

  if (!record) return;
  const now = Date.now();
  const nextAttempt = (record.attempt ?? 0) + 1;
  const nextAttemptAt = nextOutboxAttemptAt(nextAttempt, now);
  await writeVault(access, [db.outbox], () => db.outbox.update(id, {
    attempt: nextAttempt,
    attempts: nextAttempt,
    nextAttemptAt,
    nextAttemptAtMs: nextAttemptAt,
    lastError: err,
    status: "pending",
  }));
};

export const removeOutbox = async (id: string, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  await writeVault(access, [db.outbox], () => db.outbox.delete(id));
};

export const dropExpiredOutboxByConv = async (convId: string, now: number, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const records = await db.outbox.where("convId").equals(convId).toArray();

  const expired = records.filter((record) => {
    const createdAt = record.createdAt ?? record.createdAtMs ?? 0;

    const ttlMs =
      record.ttlMs ??
      (typeof record.expiresAtMs === "number" ? Math.max(0, record.expiresAtMs - createdAt) : 0);

    return createdAt + ttlMs <= now;
  });

  if (!expired.length) return;
  await writeVault(access, [db.outbox], () => db.outbox.bulkDelete(expired.map((record) => record.id)));
};

const randomBytes = (length: number) => {
  if (!globalThis.crypto?.getRandomValues) {
    return new Uint8Array(length);
  }

  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);

  return bytes;
};

const prepareErasedMessages = async (records: MessageRecord[], access?: VaultAccess) => {
  if (!records.length) return [];
  const vk = requireVaultKey(access);
  const now = Date.now();

  const sanitized = await Promise.all(
    records.map(async (record) => {
      const payload: Message = {
        id: record.id,
        convId: record.convId,
        senderId: "wiped",
        text: "",
        ts: 0,
      };

      const enc_b64 = await encryptJsonRecord(vk, record.id, "message", payload, record.enc_b64 instanceof Uint8Array ? "raw-v3" : undefined);

      return { ...record, enc_b64, ts: 0, updatedAt: now };
    })
  );

  return sanitized.map(({ updatedAt, ...record }) => { void updatedAt;

 return record; });
};

const prepareErasedMediaChunks = async (records: MediaChunkRecord[], access?: VaultAccess) => {
  if (!records.length) return [];
  const vk = requireVaultKey(access);
  const now = Date.now();

  const sanitized = await Promise.all(
    records.map(async (record) => {
      const enc_b64 = await encodeBinaryEnvelope(
        vk,
        record.id,
        "mediaChunk",
        randomBytes(32)
      );

      return { ...record, enc_b64, updatedAt: now };
    })
  );

  return sanitized;
};

export const deleteMessagesById = async (messageIds: string[], access?: VaultAccess) => {
  if (!messageIds.length) return;
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const key = requireVaultKey(access);
  const uniqueIds = Array.from(new Set(messageIds));
  const now = Date.now();

  const messageRecords = (await db.messages.bulkGet(uniqueIds)).filter(
    (record): record is MessageRecord => Boolean(record)
  );

  const mediaRecords = await db.mediaChunks
    .where("ownerId")
    .anyOf(uniqueIds)
    .and((chunk) => chunk.ownerType === "message")
    .toArray();

  const wipedMessages = await prepareErasedMessages(messageRecords, access);
  const wipedMedia = await prepareErasedMediaChunks(mediaRecords, access);
  await db.transaction("rw", [db.messages, db.mediaChunks, db.mediaTransfers, db.tombstones, db.meta], () =>
    writeVault(access, [db.messages, db.mediaChunks, db.mediaTransfers, db.tombstones], async () => {
      if (generation !== getAccountOwnerGeneration() || key !== requireVaultKey(access) ||
          JSON.stringify(await db.messages.bulkGet(uniqueIds)) !== JSON.stringify(uniqueIds.map(id => messageRecords.find(row => row.id === id))) ||
          JSON.stringify(await db.mediaChunks.where("ownerId").anyOf(uniqueIds).and(chunk => chunk.ownerType === "message").toArray()) !== JSON.stringify(mediaRecords)) {
        throw new Error("MEDIA_DELETION_CONFLICT");
      }

      await db.messages.bulkPut(wipedMessages);
      await db.messages.bulkDelete(uniqueIds);
      await db.mediaChunks.bulkPut(wipedMedia);
      await db.mediaChunks.bulkDelete(mediaRecords.map(record => record.id));
      await db.mediaTransfers.bulkDelete(uniqueIds);
      await db.tombstones.bulkPut(uniqueIds.map(id => ({ id, type: "message", deletedAt: now })));
    })
  );
};

export const deleteConversationData = async (convId: string, access?: VaultAccess) => {
  if (!convId) return;
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const key = requireVaultKey(access);

  const now = Date.now();
  const conversation = await db.conversations.get(convId);
  const messageRecords = await db.messages.where("convId").equals(convId).toArray();
  const messageIds = messageRecords.map((record) => record.id);

  const mediaChunkRecords = await db.mediaChunks
        .where("ownerId")
        .anyOf([...messageIds, convId])
        .and(chunk => chunk.ownerType === "message" && messageIds.includes(chunk.ownerId) || chunk.ownerType === "group" && chunk.ownerId === convId)
        .toArray();

  const mediaIndexes = await db.mediaIndex.where("convId").equals(convId).toArray();
  const mediaIds = mediaIndexes.map((record) => record.mediaId);

  const wipedMessages = await prepareErasedMessages(messageRecords, access);
  const wipedMedia = await prepareErasedMediaChunks(mediaChunkRecords, access);

  await db.transaction(
    "rw",
    [
      db.meta,
      db.conversations,
      db.events,
      db.outbox,
      db.mediaIndex,
      db.mediaPayloadChunks,
      db.receipts,
      db.tombstones,
      db.messages,
      db.mediaChunks,
      db.mediaTransfers,
    ],
    async () => {
      await writeVault(access, [db.messages, db.mediaChunks, db.mediaTransfers], async () => {
        if (generation !== getAccountOwnerGeneration() || key !== requireVaultKey(access) ||
            (await db.conversations.get(convId))?.enc_b64 !== conversation?.enc_b64 ||
            JSON.stringify(await db.messages.where("convId").equals(convId).toArray()) !== JSON.stringify(messageRecords) ||
            JSON.stringify(await db.mediaChunks.where("ownerId").anyOf([...messageIds, convId]).and(chunk => chunk.ownerType === "message" && messageIds.includes(chunk.ownerId) || chunk.ownerType === "group" && chunk.ownerId === convId).toArray()) !== JSON.stringify(mediaChunkRecords) ||
            JSON.stringify(await db.mediaIndex.where("convId").equals(convId).toArray()) !== JSON.stringify(mediaIndexes)) {
          throw new Error("MEDIA_DELETION_CONFLICT");
        }

        await db.messages.bulkPut(wipedMessages);
        await db.messages.bulkDelete(messageIds);
        await db.mediaChunks.bulkPut(wipedMedia);
        await db.mediaChunks.bulkDelete(mediaChunkRecords.map(record => record.id));
        await db.mediaTransfers.bulkDelete(messageIds);
      });
      await Promise.all([
        writeVault(access, [db.meta], () => db.meta.delete(`${LAMPORT_PREFIX}${convId}`)),
        writeVault(access, [db.conversations], () => db.conversations.delete(convId)),
        writeVault(access, [db.events], () => db.events.where("convId").equals(convId).delete()),
        writeVault(access, [db.outbox], () => db.outbox.where("convId").equals(convId).delete()),
        writeVault(access, [db.receipts], () => db.receipts.where("convId").equals(convId).delete()),
        writeVault(access, [db.mediaIndex], () => db.mediaIndex.where("convId").equals(convId).delete()),
        mediaIds.length
          ? writeVault(access, [db.mediaPayloadChunks], () => db.mediaPayloadChunks.where("mediaId").anyOf(mediaIds).delete())
          : Promise.resolve(0),
      ]);
      await writeVault(access, [db.tombstones], () => db.tombstones.bulkPut([
        ...messageIds.map((id) => ({ id, type: "message", deletedAt: now })),
        { id: convId, type: "conversation", deletedAt: now },
      ]));
    }
  );
};

export const deleteAllMedia = async (access?: VaultAccess) => {
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const key = requireVaultKey(access);
  const profiles = await db.profiles.toArray();
  const conversations = await db.conversations.toArray();
  const messages = await db.messages.toArray();
  const media = await db.mediaChunks.toArray();

  const profileUpdates = await Promise.all(profiles.map(async record => {
    const profile = await decryptJsonRecord<UserProfile>(key, record.id, "profile", record.enc_b64);

    if (!profile.avatarRef && !profile.profileVcard?.avatarRef) return record;

    const next = { ...profile, avatarRef: undefined,
      profileVcard: profile.profileVcard ? { ...profile.profileVcard, avatarRef: undefined } : undefined, updatedAt: Date.now() };

    return { ...record, enc_b64: await encryptJsonRecord(key, record.id, "profile", next), updatedAt: next.updatedAt };
  }));

  const conversationUpdates = await Promise.all(conversations.map(async record => {
    const conversation = await decryptJsonRecord<Conversation>(key, record.id, "conv", record.enc_b64);

    if (!conversation.sharedAvatarRef) return record;

    return { ...record, enc_b64: await encryptJsonRecord(key, record.id, "conv", { ...conversation, sharedAvatarRef: undefined }) };
  }));

  const messageUpdates = await Promise.all(messages.map(async record => {
    const message = await decryptJsonRecord<Message>(key, record.id, "message", record.enc_b64);

    if (!message.media) return record;

    return { ...record, enc_b64: await encryptJsonRecord(key, record.id, "message", { ...message, media: undefined },
      record.enc_b64 instanceof Uint8Array ? "raw-v3" : undefined) };
  }));

  const wipedMedia = await prepareErasedMediaChunks(media, access);
  await db.transaction("rw", [db.profiles, db.conversations, db.messages, db.mediaChunks, db.mediaIndex, db.mediaPayloadChunks, db.mediaTransfers, db.meta], () =>
    writeVault(access, [db.profiles, db.conversations, db.messages, db.mediaChunks, db.mediaIndex, db.mediaPayloadChunks, db.mediaTransfers], async () => {
      if (generation !== getAccountOwnerGeneration() || key !== requireVaultKey(access) ||
          JSON.stringify(await db.profiles.toArray()) !== JSON.stringify(profiles) ||
          JSON.stringify(await db.conversations.toArray()) !== JSON.stringify(conversations) ||
          JSON.stringify(await db.messages.toArray()) !== JSON.stringify(messages) ||
          JSON.stringify(await db.mediaChunks.toArray()) !== JSON.stringify(media)) throw new Error("MEDIA_DELETION_CONFLICT");
      await db.profiles.bulkPut(profileUpdates);
      await db.conversations.bulkPut(conversationUpdates);
      await db.messages.bulkPut(messageUpdates);
      await db.mediaChunks.bulkPut(wipedMedia);
      await db.mediaChunks.bulkDelete(media.map(record => record.id));
      await db.mediaPayloadChunks.clear();
      await db.mediaIndex.clear();
      await db.mediaTransfers.clear();
    })
  );
};

export const clearChatHistory = async (access?: VaultAccess) => {
  access ??= (await captureLocalOperationContext())?.vault;
  const db = access?.db ?? activeDb;
  const generation = getAccountOwnerGeneration();
  await ensureVaultAccess(access);
  const key = requireVaultKey(access);
  const conversations = await db.conversations.toArray();
  const messages = await db.messages.toArray();
  const media = await db.mediaChunks.where("ownerType").equals("message").toArray();

  const conversationUpdates = await Promise.all(conversations.map(async record => {
    const conversation = await decryptJsonRecord<Conversation>(key, record.id, "conv", record.enc_b64);
    const updated = { ...conversation, lastMessage: "", unread: 0, lastTs: 0 };

    return { ...record, enc_b64: await encryptJsonRecord(key, record.id, "conv", updated), updatedAt: Date.now() };
  }));

  const wipedMessages = await prepareErasedMessages(messages, access);
  const wipedMedia = await prepareErasedMediaChunks(media, access);
  await db.transaction("rw", [db.conversations, db.messages, db.mediaChunks, db.mediaTransfers, db.mediaIndex, db.mediaPayloadChunks, db.tombstones, db.meta], () =>
    writeVault(access, [db.conversations, db.messages, db.mediaChunks, db.mediaTransfers, db.mediaIndex, db.mediaPayloadChunks, db.tombstones], async () => {
      if (generation !== getAccountOwnerGeneration() || key !== requireVaultKey(access) ||
          JSON.stringify(await db.conversations.toArray()) !== JSON.stringify(conversations) ||
          JSON.stringify(await db.messages.toArray()) !== JSON.stringify(messages) ||
          JSON.stringify(await db.mediaChunks.where("ownerType").equals("message").toArray()) !== JSON.stringify(media)) throw new Error("MEDIA_DELETION_CONFLICT");
      await db.conversations.bulkPut(conversationUpdates);
      await db.messages.bulkPut(wipedMessages);
      await db.messages.bulkDelete(messages.map(record => record.id));
      await db.mediaChunks.bulkPut(wipedMedia);
      await db.mediaChunks.bulkDelete(media.map(record => record.id));
      await db.mediaTransfers.clear();
      await db.mediaPayloadChunks.clear();
      await db.mediaIndex.clear();
      await db.tombstones.bulkPut(messages.map(record => ({ id: record.id, type: "message", deletedAt: Date.now() })));
    })
  );
};
