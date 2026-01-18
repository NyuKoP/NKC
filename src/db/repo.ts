import { db, ensureDbOpen, resetDb } from "./schema";
import type { EncryptedRecord, MediaChunkRecord, MessageRecord } from "./schema";
import {
  chunkBuffer,
  createVaultHeader,
  decodeBinaryEnvelope,
  decryptJsonRecord,
  deriveMkm,
  deriveVk,
  encodeBinaryEnvelope,
  encryptJsonRecord,
  type VaultHeader,
} from "../crypto/vault";
import { clearVaultKey, getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import { createId } from "../utils/ids";

export type AvatarRef = {
  ownerType: "profile";
  ownerId: string;
  mime: string;
  total: number;
  chunkSize: number;
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

export type UserProfile = {
  id: string;
  displayName: string;
  status: string;
  theme: "dark" | "light";
  avatarRef?: AvatarRef;
  kind: "user" | "friend";
  friendId?: string;
  friendStatus?: "normal" | "hidden" | "blocked";
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
  lastTs: number;
  lastMessage: string;
  participants: string[];
};

export type Message = {
  id: string;
  convId: string;
  senderId: string;
  text: string;
  ts: number;
  media?: MediaRef;
};

const VAULT_META_KEY = "vault_header_v2";
const VAULT_KEY_ID_KEY = "vault_key_id_v1";
const MEDIA_CHUNK_SIZE = 256 * 1024;

const requireVaultKey = () => {
  const vk = getVaultKey();
  if (!vk) throw new Error("Vault is locked");
  return vk;
};

const toB64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

const computeVaultKeyId = async (vk: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null;
  const vkBytes = new Uint8Array(vk);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", vkBytes);
  return toB64(new Uint8Array(digest).slice(0, 16));
};

export const getVaultKeyId = async () => {
  await ensureDbOpen();
  const record = await db.meta.get(VAULT_KEY_ID_KEY);
  return record?.value || null;
};

export const setVaultKeyId = async (vk: Uint8Array) => {
  await ensureDbOpen();
  const keyId = await computeVaultKeyId(vk);
  if (!keyId) return null;
  await db.meta.put({ key: VAULT_KEY_ID_KEY, value: keyId });
  return keyId;
};

export const verifyVaultKeyId = async (vk: Uint8Array) => {
  await ensureDbOpen();
  const stored = await getVaultKeyId();
  if (!stored) return true;
  const current = await computeVaultKeyId(vk);
  if (!current) return true;
  return stored === current;
};

export const getVaultHeader = async (): Promise<VaultHeader | null> => {
  await ensureDbOpen();
  const record = await db.meta.get(VAULT_META_KEY);
  if (!record) return null;
  try {
    return JSON.parse(record.value) as VaultHeader;
  } catch (error) {
    await db.meta.delete(VAULT_META_KEY);
    return null;
  }
};

export const ensureVaultHeader = async (): Promise<VaultHeader> => {
  await ensureDbOpen();
  const existing = await getVaultHeader();
  if (existing) return existing;
  const header = await createVaultHeader();
  await db.meta.put({ key: VAULT_META_KEY, value: JSON.stringify(header) });
  return header;
};

export const unlockVault = async (recoveryKey: string) => {
  const header = await ensureVaultHeader();
  const mkm = await deriveMkm(recoveryKey, header);
  const vk = await deriveVk(mkm);
  setVaultKey(vk);
  await setVaultKeyId(vk);
  return header;
};

export const bootstrapVault = async () => {
  await ensureVaultHeader();
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const vk = new Uint8Array(32);
  globalThis.crypto.getRandomValues(vk);
  setVaultKey(vk);
  await setVaultKeyId(vk);
};

export const lockVault = () => {
  clearVaultKey();
};

export const saveProfile = async (profile: UserProfile) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const enc_b64 = await encryptJsonRecord(vk, profile.id, "profile", profile);
  const record: EncryptedRecord = {
    id: profile.id,
    enc_b64,
    updatedAt: Date.now(),
  };
  await db.profiles.put(record);
};

export const deleteProfile = async (profileId: string) => {
  await ensureDbOpen();
  requireVaultKey();
  await db.profiles.delete(profileId);
};

export const listProfiles = async () => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const records = await db.profiles.toArray();
  const profiles = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<UserProfile>(vk, record.id, "profile", record.enc_b64)
    )
  );
  return profiles;
};

export const saveConversation = async (conversation: Conversation) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const enc_b64 = await encryptJsonRecord(
    vk,
    conversation.id,
    "conv",
    conversation
  );
  await db.conversations.put({
    id: conversation.id,
    enc_b64,
    updatedAt: Date.now(),
  });
};

export const listConversations = async () => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const records = await db.conversations.toArray();
  const conversations = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<Conversation>(vk, record.id, "conv", record.enc_b64)
    )
  );
  return conversations;
};

export const saveMessage = async (message: Message) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const enc_b64 = await encryptJsonRecord(vk, message.id, "message", message);
  const record: MessageRecord = {
    id: message.id,
    convId: message.convId,
    ts: message.ts,
    enc_b64,
  };
  await db.messages.put(record);
};

export const listMessagesByConv = async (convId: string) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  const records = await db.messages.where("convId").equals(convId).sortBy("ts");
  const messages = await Promise.all(
    records.map((record) =>
      decryptJsonRecord<Message>(vk, record.id, "message", record.enc_b64)
    )
  );
  return messages;
};

export const saveProfilePhoto = async (ownerId: string, file: File) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  await db.mediaChunks
    .where("ownerId")
    .equals(ownerId)
    .and((chunk) => chunk.ownerType === "profile")
    .delete();

  const buffer = await file.arrayBuffer();
  const chunks = chunkBuffer(buffer, MEDIA_CHUNK_SIZE);
  const total = chunks.length;
  const now = Date.now();
  const records: MediaChunkRecord[] = [];

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunkId = `${ownerId}:${idx}`;
    const enc_b64 = await encodeBinaryEnvelope(
      vk,
      chunkId,
      "mediaChunk",
      chunks[idx]
    );
    records.push({
      id: chunkId,
      ownerType: "profile",
      ownerId,
      idx,
      enc_b64,
      mime: file.type || "application/octet-stream",
      total,
      updatedAt: now,
    });
  }

  await db.mediaChunks.bulkPut(records);

  const avatarRef: AvatarRef = {
    ownerType: "profile",
    ownerId,
    mime: file.type || "application/octet-stream",
    total,
    chunkSize: MEDIA_CHUNK_SIZE,
  };

  return avatarRef;
};

export const loadProfilePhoto = async (avatarRef?: AvatarRef) => {
  await ensureDbOpen();
  if (!avatarRef) return null;
  const vk = requireVaultKey();
  const chunks = await db.mediaChunks
    .where("ownerId")
    .equals(avatarRef.ownerId)
    .and((chunk) => chunk.ownerType === "profile")
    .sortBy("idx");

  if (!chunks.length) return null;

  const decrypted = await Promise.all(
    chunks.map((chunk) =>
      decodeBinaryEnvelope(vk, chunk.id, "mediaChunk", chunk.enc_b64)
    )
  );
  const blob = new Blob(decrypted, { type: avatarRef.mime });
  return blob;
};

export const saveMessageMedia = async (messageId: string, file: File) => {
  await ensureDbOpen();
  const vk = requireVaultKey();
  await db.mediaChunks
    .where("ownerId")
    .equals(messageId)
    .and((chunk) => chunk.ownerType === "message")
    .delete();

  const buffer = await file.arrayBuffer();
  const chunks = chunkBuffer(buffer, MEDIA_CHUNK_SIZE);
  const total = chunks.length;
  const now = Date.now();
  const records: MediaChunkRecord[] = [];

  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunkId = `${messageId}:${idx}`;
    const enc_b64 = await encodeBinaryEnvelope(
      vk,
      chunkId,
      "mediaChunk",
      chunks[idx]
    );
    records.push({
      id: chunkId,
      ownerType: "message",
      ownerId: messageId,
      idx,
      enc_b64,
      mime: file.type || "application/octet-stream",
      total,
      updatedAt: now,
    });
  }

  await db.mediaChunks.bulkPut(records);

  const mediaRef: MediaRef = {
    ownerType: "message",
    ownerId: messageId,
    mime: file.type || "application/octet-stream",
    total,
    chunkSize: MEDIA_CHUNK_SIZE,
    name: file.name,
    size: file.size,
  };

  return mediaRef;
};

export const loadMessageMedia = async (mediaRef?: MediaRef) => {
  await ensureDbOpen();
  if (!mediaRef) return null;
  const vk = requireVaultKey();
  const chunks = await db.mediaChunks
    .where("ownerId")
    .equals(mediaRef.ownerId)
    .and((chunk) => chunk.ownerType === "message")
    .sortBy("idx");

  if (!chunks.length) return null;

  const decrypted = await Promise.all(
    chunks.map((chunk) =>
      decodeBinaryEnvelope(vk, chunk.id, "mediaChunk", chunk.enc_b64)
    )
  );
  const blob = new Blob(decrypted, { type: mediaRef.mime });
  return blob;
};

export const seedVaultData = async (user: UserProfile) => {
  await ensureDbOpen();
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

  await saveProfile(user);
  for (const friend of friends) {
    await saveProfile(friend);
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
    await saveConversation(conv);
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
      await saveMessage(message);
    }
  }

  return { friends, conversations };
};

export const rotateVaultKeys = async (
  newRecoveryKey: string,
  onProgress?: (value: number) => void
) => {
  await ensureDbOpen();
  const oldVk = requireVaultKey();
  const newHeader = await createVaultHeader();
  const newMkm = await deriveMkm(newRecoveryKey, newHeader);
  const newVk = await deriveVk(newMkm);

  const profiles = await db.profiles.toArray();
  const conversations = await db.conversations.toArray();
  const messages = await db.messages.toArray();
  const mediaChunks = await db.mediaChunks.toArray();
  const total =
    profiles.length + conversations.length + messages.length + mediaChunks.length;
  let processed = 0;

  const bump = () => {
    processed += 1;
    if (onProgress && total > 0) {
      onProgress(Math.round((processed / total) * 100));
    }
  };

  if (onProgress && total === 0) {
    onProgress(100);
  }

  for (const record of profiles) {
    const data = await decryptJsonRecord<UserProfile>(
      oldVk,
      record.id,
      "profile",
      record.enc_b64
    );
    const enc_b64 = await encryptJsonRecord(newVk, record.id, "profile", data);
    await db.profiles.put({ ...record, enc_b64, updatedAt: Date.now() });
    bump();
  }

  for (const record of conversations) {
    const data = await decryptJsonRecord<Conversation>(
      oldVk,
      record.id,
      "conv",
      record.enc_b64
    );
    const enc_b64 = await encryptJsonRecord(newVk, record.id, "conv", data);
    await db.conversations.put({ ...record, enc_b64, updatedAt: Date.now() });
    bump();
  }

  for (const record of messages) {
    const data = await decryptJsonRecord<Message>(
      oldVk,
      record.id,
      "message",
      record.enc_b64
    );
    const enc_b64 = await encryptJsonRecord(newVk, record.id, "message", data);
    await db.messages.put({ ...record, enc_b64 });
    bump();
  }

  for (const record of mediaChunks) {
    const data = await decodeBinaryEnvelope(
      oldVk,
      record.id,
      "mediaChunk",
      record.enc_b64
    );
    const enc_b64 = await encodeBinaryEnvelope(
      newVk,
      record.id,
      "mediaChunk",
      data
    );
    await db.mediaChunks.put({ ...record, enc_b64, updatedAt: Date.now() });
    bump();
  }

  await db.meta.put({ key: VAULT_META_KEY, value: JSON.stringify(newHeader) });
  setVaultKey(newVk);
  await setVaultKeyId(newVk);
};

export const resetVaultStorage = async () => {
  clearVaultKey();
  await resetDb();
};

export const wipeVault = async () => {
  await resetVaultStorage();
};
