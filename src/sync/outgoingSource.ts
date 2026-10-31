import type { ReceiveContext } from "../accounts/receiveContext";
import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBinaryEnvelope, decryptJsonRecord } from "../crypto/vault";
import { getStoredMessage, listConversations, listProfiles, loadProfilePhoto, readMessageMediaChunks, type UserProfile } from "../db/repo";
import { getAccountRootIdentity } from "../devices/deviceApprovals";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { parseIncomingMediaRef } from "../security/mediaPolicy";
import { getPrivacyPrefs } from "../security/preferences";
import { getSodium } from "../security/sodium";
import { verifyLogicalMediaChunk, verifyLogicalRead, type LogicalMediaChunk, type LogicalRead } from "./receivedText";
import { readMediaCustody } from "../storage/mediaCustody";

const changed = (): never => { throw new Error("OUTGOING_SOURCE_CHANGED"); };
const equal = (left: unknown, right: unknown) => encodeBase64Url(canonicalBytes(left)) === encodeBase64Url(canonicalBytes(right));

/** A signed body is sendable only while its local source and sharing decision remain current. */
export const assertCurrentOutgoingSource = async (convId: string, partner: UserProfile, body: unknown,
  context: ReceiveContext, expectedStamp?: string): Promise<string | undefined> => {
  const value = body as Record<string, unknown> | null;
  if (!value || !["account_read", "account_profile", "account_media"].includes(String(value.type)) &&
      !(value.type === "media" && value.phase === "chunk" && value.ownerType !== "group")) {
    if (expectedStamp !== undefined) return changed();
    return undefined;
  }
  await context.vault.assertMain();
  const profiles = await listProfiles(context.vault), users = profiles.filter(row => row.kind === "user");
  const conv = (await listConversations(context.vault)).find(row => row.id === convId);
  if (users.length !== 1 || !conv || conv.hidden || conv.blocked || !conv.participants.includes(users[0].id) ||
      !conv.participants.includes(partner.id) || await context.vault.db.tombstones.get(convId)) return changed();
  const currentPartner = profiles.find(row => row.id === partner.id && row.kind === "friend");
  if (!currentPartner || currentPartner.friendStatus !== "normal" || currentPartner.identityPub !== partner.identityPub ||
      currentPartner.dhPub !== partner.dhPub || currentPartner.trust?.status === "blocked" || currentPartner.trust?.status === "changed" ||
      currentPartner.verification?.status === "key_changed") return changed();
  const root = await getAccountRootIdentity(context);
  let source: unknown;
  if (value.type === "account_read") {
    const read = body as LogicalRead, prefs = await getPrivacyPrefs(context);
    const message = await getStoredMessage(read.anchorMsgId, context.vault), proof = message?.logicalProof;
    const cursor = await context.vault.db.receipts.get(`read_cursor:${convId}:${users[0].id}`);
    if (!prefs.readReceipts || read.readerAccountIdentity !== root || !await verifyLogicalRead(read, context) ||
        !message || message.convId !== convId || !proof || await context.vault.db.tombstones.get(message.id) ||
        proof.id !== read.anchorMsgId || proof.senderAccountIdentity !== read.peerAccountIdentity ||
        proof.conversationIdentity !== read.conversationIdentity || proof.groupId !== read.groupId || proof.ts !== read.cursorTs ||
        (!proof.groupId && (proof.recipientAccountIdentity !== root || read.peerAccountIdentity !== partner.identityPub)) || !cursor?.logicalRead_enc ||
        cursor.kind !== "read_cursor" || cursor.convId !== convId || cursor.actorId !== users[0].id ||
        cursor.anchorMsgId !== message.id || cursor.cursorTs !== read.cursorTs ||
        !equal(await decryptJsonRecord(context.vault.key, cursor.id, "receipt", cursor.logicalRead_enc), read)) return changed();
    source = { read, anchor: proof, cursor: { anchorMsgId: cursor.anchorMsgId, cursorTs: cursor.cursorTs }, readReceipts: true };
  } else if (value.type === "account_profile") {
    const profile = value.profile as { displayName?: unknown; status?: unknown; presence?: { status?: unknown }; avatar?: { mime?: unknown; data?: unknown } } | undefined;
    const user = users[0], prefs = await getPrivacyPrefs(context);
    if (value.accountRootIdentity !== root || !profile || user.displayName !== profile.displayName || user.status !== profile.status ||
        prefs.hidePresence && profile.presence && profile.presence.status !== "offline") return changed();
    if (profile.avatar) {
      const avatar = await loadProfilePhoto(user.avatarRef, context.vault);
      if (!avatar || avatar.type !== profile.avatar.mime || typeof profile.avatar.data !== "string" ||
          encodeBase64Url(new Uint8Array(await avatar.arrayBuffer())) !== profile.avatar.data) return changed();
    }
    source = { id: user.id, updatedAt: user.updatedAt, profileUpdatedAt: user.profileUpdatedAt, avatarRef: user.avatarRef,
      displayName: user.displayName, status: user.status, hidePresence: prefs.hidePresence, body };
  } else {
    const certified = value.type === "account_media", proof = certified ? value.proof as LogicalMediaChunk : undefined;
    const messageId = certified ? proof?.messageId : value.ownerId, idx = certified ? proof?.idx : value.idx;
    if (typeof messageId !== "string" || !Number.isSafeInteger(idx) || Number(idx) < 0 || typeof value.b64 !== "string") return changed();
    const message = await getStoredMessage(messageId, context.vault), manifest = message && parseIncomingMediaRef(message.media, messageId);
    const id = `${messageId}:${idx}`, chunk = await context.vault.db.mediaChunks.get(id);
    const custody = !chunk ? await readMediaCustody(messageId, context.vault.db, context.vault.key) : undefined;

    if (!message || message.convId !== convId || await context.vault.db.tombstones.get(messageId) || !manifest || Number(idx) >= manifest.total ||
        (chunk ? chunk.ownerType !== "message" || chunk.ownerId !== messageId || chunk.idx !== idx || chunk.total !== manifest.total :
          custody?.phase !== "plaintext")) return changed();
    let bytes: Uint8Array;
    try { bytes = decodeBase64Url(value.b64); } catch { return changed(); }

    let stored: Uint8Array;

    if (chunk) stored = new Uint8Array(await decodeBinaryEnvelope(context.vault.key, id, "mediaChunk", chunk.enc_b64));
    else {
      const reader = readMessageMediaChunks(manifest, context.vault, Number(idx));

      try {
        const result = await reader.next();

        if (result.done || result.value.idx !== idx) return changed();
        stored = result.value.bytes;
      } finally { await reader.return(undefined); }
    }

    if (encodeBase64Url(bytes) !== value.b64 || bytes.length !== Math.min(manifest.chunkSize, manifest.size - Number(idx) * manifest.chunkSize) ||
        bytes.length !== stored.length || !(await getSodium()).memcmp(bytes, stored)) return changed();
    if (certified) {
      const logical = message.logicalProof;
      const storedProof = chunk?.logicalProof_enc ? await decryptJsonRecord(context.vault.key, id, "media-proof", chunk.logicalProof_enc) : custody?.proofs?.[Number(idx)];

      if (!proof || !logical || logical.id !== messageId || !storedProof || !await verifyLogicalMediaChunk(proof, bytes, context) ||
          proof.conversationIdentity !== logical.conversationIdentity || proof.senderAccountIdentity !== logical.senderAccountIdentity ||
          proof.recipientAccountIdentity !== logical.recipientAccountIdentity || proof.groupId !== logical.groupId ||
          proof.total !== manifest.total || proof.chunkSize !== manifest.chunkSize || proof.size !== manifest.size || proof.mime !== manifest.mime ||
          !equal(storedProof, proof)) return changed();
    } else if (message.senderId !== users[0].id || value.total !== manifest.total || value.chunkSize !== manifest.chunkSize ||
        value.size !== manifest.size || value.mime !== manifest.mime || value.name !== manifest.name) return changed();
    source = { messageId, manifest, logicalProof: message.logicalProof, senderId: message.senderId, proof,
      idx, bytesHash: encodeBase64Url((await getSodium()).crypto_hash_sha256(bytes)) };
  }
  const stamp = encodeBase64Url((await getSodium()).crypto_hash_sha256(canonicalBytes(source)));
  await context.vault.assertMain();
  if (expectedStamp !== undefined && expectedStamp !== stamp) return changed();
  return stamp;
};
