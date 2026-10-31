import { legacyEventJson } from "../storage/storedPayload";
import type { EventRecord } from "../db/schema";
import { writeVault, type VaultAccess } from "../db/vaultAccess";
import { decodeBinaryEnvelope, decryptJsonRecord, encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import { computeEnvelopeHash, type Envelope } from "../crypto/box";
import { getStoredMessage, readMessageMediaChunks, type Conversation } from "../db/repo";
import { parseIncomingMediaRef } from "../security/mediaPolicy";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import { advanceMediaTransferAcknowledgement, publishMediaTransferProgress, type MediaTransferProgress } from "../storage/mediaTransferStore";
import { reconcileAcknowledgedNativeRetries } from "./deliveryPolicy";
import { mediaCustodyKey, readMediaCustody } from "../storage/mediaCustody";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";

export type MediaStoredReceipt = { type: "rcpt"; kind: "media_stored"; msgId: string; eventHash: string;
  convId: string; ownerId: string; idx: number; chunkHash: string };

type MediaBinding = { ownerId: string; idx: number; total: number; size: number; chunkSize: number; mime: string; chunkHash: string };

export const mediaChunkBinding = async (body: unknown): Promise<MediaBinding | null> => {
  if (!body || typeof body !== "object") return null;

  const value = body as { type?: string; phase?: string; ownerType?: string; ownerId?: string; idx?: number;
    total?: number; size?: number; chunkSize?: number; mime?: string; b64?: string; proof?: MediaBinding & { messageId: string } };

  if (!(value.type === "account_media" || value.type === "media" && value.phase === "chunk" && (!value.ownerType || value.ownerType === "message")) ||
      typeof value.b64 !== "string") return null;
  const source = value.type === "account_media" ? value.proof : value;
  const ownerId = value.type === "account_media" ? value.proof?.messageId : value.ownerId;

  if (!source || !ownerId || ownerId.length > 256 || !Number.isSafeInteger(source.idx) || !Number.isSafeInteger(source.total) ||
      source.idx! < 0 || source.idx! >= source.total! || !Number.isSafeInteger(source.size) || !Number.isSafeInteger(source.chunkSize) ||
      source.size! <= 0 || source.chunkSize! <= 0 || source.total !== Math.ceil(source.size! / source.chunkSize!) || typeof source.mime !== "string") return null;
  const bytes = decodeBase64Url(value.b64);

  if (bytes.length !== Math.min(source.chunkSize!, source.size! - source.idx! * source.chunkSize!)) return null;
  const chunkHash = encodeBase64Url((await getSodium()).crypto_generichash(32, bytes));

  if (value.type === "account_media" && value.proof?.chunkHash !== chunkHash) return null;

  return { ownerId, idx: source.idx!, total: source.total!, size: source.size!, chunkSize: source.chunkSize!, mime: source.mime, chunkHash };
};

const matchingLocalSource = async (binding: MediaBinding, access: VaultAccess) => {
  const messageRecord = await access.db.messages.get(binding.ownerId);
  const message = await getStoredMessage(binding.ownerId, access);
  const manifest = message && parseIncomingMediaRef(message.media, message.id);
  const chunk = await access.db.mediaChunks.get(`${binding.ownerId}:${binding.idx}`);
  const custodyRecord = await access.db.meta.get(mediaCustodyKey(binding.ownerId));
  const conversationRecord = message ? await access.db.conversations.get(message.convId) : undefined;
  const conversation = conversationRecord ? await decryptJsonRecord<Conversation>(access.key, conversationRecord.id, "conv", conversationRecord.enc_b64) : undefined;

  if (await access.db.tombstones.get(binding.ownerId) || message && await access.db.tombstones.get(message.convId)) return null;

  if (!messageRecord || !message || !manifest || manifest.total !== binding.total || manifest.size !== binding.size ||
      manifest.chunkSize !== binding.chunkSize || manifest.mime !== binding.mime || chunk && (chunk.ownerType !== "message" ||
      chunk.ownerId !== binding.ownerId || chunk.idx !== binding.idx || chunk.total !== binding.total || chunk.mime !== binding.mime) ||
      !conversation || conversation.hidden || conversation.blocked || !conversation.participants.includes(message.senderId)) return null;
  let bytes: Uint8Array;

  if (chunk) bytes = new Uint8Array(await decodeBinaryEnvelope(access.key, chunk.id, "mediaChunk", chunk.enc_b64));
  else {
    const custody = await readMediaCustody(binding.ownerId, access.db, access.key);

    if (custody?.phase !== "plaintext") return null;
    const reader = readMessageMediaChunks(manifest, access, binding.idx);

    try {
      const result = await reader.next();

      if (result.done || result.value.idx !== binding.idx) return null;
      bytes = result.value.bytes;
    } finally { await reader.return(undefined); }
  }

  if (bytes.length !== Math.min(binding.chunkSize, binding.size - binding.idx * binding.chunkSize) ||
      encodeBase64Url((await getSodium()).crypto_generichash(32, bytes)) !== binding.chunkHash ||
      (await access.db.meta.get(mediaCustodyKey(binding.ownerId)))?.value !== custodyRecord?.value) return null;

  return { messageRecord, message, chunk, custodyRecord, conversationRecord };
};

export const readStoredMediaReceipt = async (event: EventRecord, access: VaultAccess): Promise<MediaStoredReceipt | null> => {
  if (event.applicationState !== "stored" || !event.applicationCryptoCommitted || !event.mediaReceipt_enc || event.ratchetVersion !== 2) return null;
  const envelope = JSON.parse(legacyEventJson(event)) as Envelope;

  if (envelope.header.eventId !== event.eventId || await computeEnvelopeHash(envelope) !== event.eventHash) return null;
  const binding = await decryptJsonRecord<MediaBinding>(access.key, event.eventId, "media-receipt", event.mediaReceipt_enc);

  if (!await matchingLocalSource(binding, access)) return null;
  await access.assertMain();

  if (JSON.stringify(await access.db.events.get(event.eventId)) !== JSON.stringify(event)) return null;

  return { type: "rcpt", kind: "media_stored", msgId: event.eventId, eventHash: event.eventHash,
    convId: event.convId, ownerId: binding.ownerId, idx: binding.idx, chunkHash: binding.chunkHash };
};

/** Authentication and current session checks remain in the existing envelope receiver. */
export const applyAuthenticatedMediaReceipt = async (receipt: MediaStoredReceipt,
  peer: { peerIdentityPub: string; peerAccountIdentity: string; peerDeviceId?: string }, access: VaultAccess, commit = true,
  application?: { eventId: string; eventHash: string; wireConvId: string; lamport: number }): Promise<boolean> => {
  if (receipt?.type !== "rcpt" || receipt.kind !== "media_stored" || !receipt.msgId || receipt.msgId.length > 256 ||
      !receipt.convId || !receipt.ownerId || receipt.ownerId.length > 256 || !Number.isSafeInteger(receipt.idx) || receipt.idx < 0 ||
      !/^[a-zA-Z0-9_-]{43}$/.test(receipt.eventHash) || !/^[a-zA-Z0-9_-]{43}$/.test(receipt.chunkHash)) return false;
  await access.assertMain();
  const outgoing = await access.db.outbox.get(receipt.msgId);
  const original = await access.db.events.get(receipt.msgId);

  if (outgoing?.payloadFormat === "nkcp-v2" || original?.envelopeFormat === "nkce-v1") return false;

  if (!outgoing || !original?.outgoingBody_enc || outgoing.ownerAccountId !== access.accountId || outgoing.convId !== receipt.convId ||
      outgoing.recipientIdentityPub !== peer.peerIdentityPub || original.convId !== receipt.convId || original.eventHash !== receipt.eventHash ||
      original.envelopeJson !== outgoing.ciphertext || outgoing.retention === "transient") return false;
  const envelope = JSON.parse(legacyEventJson(original)) as Envelope;

  if (envelope.header.eventId !== receipt.msgId || await computeEnvelopeHash(envelope) !== receipt.eventHash || envelope.header.rk?.v !== 2 ||
      envelope.header.deviceDelivery && envelope.header.deviceDelivery.recipientDeviceId !== peer.peerDeviceId) return false;
  const ownLinked = envelope.header.deviceDelivery?.author.accountRootIdentityPub === peer.peerAccountIdentity;
  const body = await decryptJsonRecord(access.key, original.eventId, `outgoing:${original.eventHash}`, original.outgoingBody_enc);
  const binding = await mediaChunkBinding(body);

  if (!binding || binding.ownerId !== receipt.ownerId || binding.idx !== receipt.idx || binding.chunkHash !== receipt.chunkHash) return false;
  const source = await matchingLocalSource(binding, access);

  if (!source || original.localConvId !== source.message.convId) return false;
  const transfer = await access.db.mediaTransfers.get(binding.ownerId);
  const progress = transfer ? await decryptJsonRecord<MediaTransferProgress>(access.key, binding.ownerId, "mediaTransfer", transfer.enc_b64) : null;

  if (!ownLinked && (!progress || progress.convId !== source.message.convId || progress.totalChunks !== binding.total ||
      !progress.recipients?.includes(peer.peerAccountIdentity))) return false;
  const next = ownLinked ? null : advanceMediaTransferAcknowledgement(progress!, binding.idx, peer.peerAccountIdentity);

  if (!ownLinked && !next) return false;
  const candidate = application ? await access.db.events.get(application.eventId) : undefined;

  if (application && (!candidate?.applicationCryptoCommitted || candidate.bodyType !== "rcpt" || candidate.ratchetVersion !== 2 ||
      candidate.eventHash !== application.eventHash || candidate.convId !== application.wireConvId || candidate.localConvId !== receipt.convId ||
      candidate.lamport !== application.lamport || !Number.isSafeInteger(application.lamport) ||
      candidate.applicationState !== "stored" && !candidate.authenticatedBody_enc)) return false;
  const previousReceipt = await access.db.receipts.get(`media-stored:${receipt.msgId}`);

  if (previousReceipt && (previousReceipt.msgId !== binding.ownerId || previousReceipt.convId !== source.message.convId || previousReceipt.kind !== "media_stored")) return false;

  if (!commit) { await access.assertMain(); return true; }

  const enc_b64 = next ? await encryptJsonRecord(access.key, binding.ownerId, "mediaTransfer", next) : undefined;
  await writeVault(access, [access.db.outbox, access.db.events, access.db.receipts, access.db.messages, access.db.conversations, access.db.mediaChunks, access.db.mediaTransfers, access.db.meta, access.db.tombstones], async () => {
    if (JSON.stringify(await access.db.outbox.get(outgoing.id)) !== JSON.stringify(outgoing) ||
        JSON.stringify(await access.db.events.get(original.eventId)) !== JSON.stringify(original) ||
        !sameStoredCiphertext((await access.db.messages.get(binding.ownerId))?.enc_b64, source.messageRecord.enc_b64) ||
        (await access.db.mediaChunks.get(`${binding.ownerId}:${binding.idx}`))?.enc_b64 !== source.chunk?.enc_b64 ||
        (await access.db.meta.get(mediaCustodyKey(binding.ownerId)))?.value !== source.custodyRecord?.value ||
        (await access.db.mediaTransfers.get(binding.ownerId))?.enc_b64 !== transfer?.enc_b64 ||
        (await access.db.conversations.get(source.message.convId))?.enc_b64 !== source.conversationRecord?.enc_b64 ||
        JSON.stringify(await access.db.receipts.get(`media-stored:${receipt.msgId}`)) !== JSON.stringify(previousReceipt) ||
        await access.db.tombstones.get(binding.ownerId) || await access.db.tombstones.get(source.message.convId) ||
        application && JSON.stringify(await access.db.events.get(application.eventId)) !== JSON.stringify(candidate)) throw new Error("OWNER_APPLICATION_CONFLICT");
    await access.db.receipts.put({ id: `media-stored:${receipt.msgId}`, convId: source.message.convId, msgId: binding.ownerId,
      kind: "media_stored", ts: next?.updatedAt ?? Date.now() });
    await access.db.outbox.update(outgoing.id, { status: "acked", ackDeadlineMs: undefined, inFlightAtMs: undefined, lastError: undefined, nativeRetryStopped: false });

    if (next && enc_b64) await access.db.mediaTransfers.put({ transferId: binding.ownerId, enc_b64, updatedAt: next.updatedAt });

    if (application) {
      await access.db.events.update(application.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `lamport_v1:${application.wireConvId}`;
      const current = Number((await access.db.meta.get(key))?.value ?? 0);
      await access.db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, application.lamport)) });
    }
  });

  try {
    emitFlowTraceLog({ event: "mediaTransfer:storedAck:committed", authenticated: true,
      durableCommit: true, transferComplete: next?.status === "complete" });
  } catch { /* Observation follows commit and cannot affect custody or completion. */ }

  if (next) publishMediaTransferProgress(next, access);
  await reconcileAcknowledgedNativeRetries(access, [outgoing.id]);

  return true;
};
