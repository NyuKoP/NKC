import { computeBinaryRetryId, legacyEventJson, legacyOutboxCiphertext, readEventEnvelope, sameOutboxPayload, samePayloadBytes, validateBinaryEventOutbox } from "../storage/storedPayload";
import type { EventRecord, OutboxRecord, ReceiptRecord } from "../db/schema";
import { computeExpiresAt } from "./ttl";
import { claimOutbox, deleteExpiredOutbox, deleteOutbox, getOutbox, putOutbox, updateOutbox } from "../storage/outboxStore";
import { putReceipt } from "../storage/receiptStore";
import { markMediaTransferAcked } from "../storage/mediaTransferStore";
import { writeVault, type VaultAccess } from "../db/vaultAccess";
import { getStoredMessage } from "../db/repo";
import { decryptJsonRecord, encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import type { LogicalDelivered } from "../sync/receivedText";
import { canonicalBytes } from "../crypto/canonicalJson";
import { computeEnvelopeHash } from "../crypto/box";
import { decodeBinaryTransportPacketV2 } from "../adapters/transports/packetCodec";

// Advisory fairness only; every selected row still passes current ownership and custody checks.
const nativeReconcileCursors = new WeakMap<VaultAccess["db"], Map<string, string>>();

export const enqueueOutgoing = async (record: OutboxRecord, access?: VaultAccess, event?: EventRecord,
  admission?: Parameters<typeof claimOutbox>[3]) => {
  const createdAtMs = record.createdAtMs ?? Date.now();

  const normalized: OutboxRecord = {
    ...record,
    createdAtMs,
    expiresAtMs: record.expiresAtMs ?? computeExpiresAt(createdAtMs),
    status: record.status ?? "pending",
    attempts: record.attempts ?? 0,
    nextAttemptAtMs: record.nextAttemptAtMs ?? createdAtMs,
  };

  if (access) return claimOutbox(normalized, access, event, admission);

  if (event) throw new Error("OWNER_REQUIRED");
  await putOutbox(normalized);

  return true;
};

/** Called only after ordinary v2 envelope authentication; outer transport ACKs never call this. */
export const applyAuthenticatedDeliveredReceipt = async (receipt: {
  messageId: string; convId: string; peerIdentityPub: string; eventHash: string;
  logicalMessageId?: string; logicalConvId?: string; recipientAccountIdentity?: string;
  logicalDelivered?: LogicalDelivered;
}, access: VaultAccess, commit = true, application?: {
  eventId: string; eventHash: string; wireConvId: string; lamport: number;
}): Promise<boolean> => {
  if (!receipt.messageId || receipt.messageId.length > 256 || !receipt.convId || !receipt.peerIdentityPub ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(receipt.eventHash)) return false;
  await access.assertMain();
  const beforeEvent = await access.db.events.get(receipt.messageId);
  let friendIntentId: string | undefined;

  if (!receipt.logicalMessageId && beforeEvent) {
    try {
      const outgoing = beforeEvent.envelopeFormat === "nkce-v1" ? readEventEnvelope(beforeEvent) : JSON.parse(legacyEventJson(beforeEvent));

      if (!outgoing.header?.deviceDelivery && outgoing.header?.eventId === receipt.messageId &&
          typeof outgoing.header.friendDeliveryId === "string" && outgoing.header.friendDeliveryId.length <= 256) friendIntentId = outgoing.header.friendDeliveryId;
    } catch { return false; }
  }

  const humanId = receipt.logicalMessageId ?? friendIntentId ?? receipt.messageId;
  const humanConvId = receipt.logicalConvId ?? receipt.convId;
  const beforeMessage = await access.db.messages.get(humanId);
  const message = await getStoredMessage(humanId, access);

  if (!beforeMessage || !message || message.convId !== humanConvId ||
      (receipt.logicalMessageId && (!message.logicalProof || message.logicalProof.id !== humanId ||
        (message.logicalProof.groupId ? receipt.logicalDelivered?.groupId !== message.logicalProof.groupId ||
          receipt.logicalDelivered.recipientAccountIdentity !== receipt.recipientAccountIdentity :
          message.logicalProof.recipientAccountIdentity !== receipt.recipientAccountIdentity)))) return false;
  const beforeOutgoing = await access.db.outbox.get(receipt.messageId);

  if (!beforeOutgoing || beforeOutgoing.ownerAccountId !== access.accountId || beforeOutgoing.convId !== receipt.convId ||
      beforeOutgoing.recipientIdentityPub !== receipt.peerIdentityPub || !beforeEvent ||
      (beforeEvent.envelopeFormat === "nkce-v1" ? beforeEvent.localConvId : beforeEvent.convId) !== receipt.convId ||
      beforeEvent.eventHash !== receipt.eventHash || beforeOutgoing.retention === "transient" || beforeOutgoing.binaryTransport) return false;
  let nativeRetryId: string | undefined;

  if (beforeOutgoing.payloadFormat === "nkcp-v2") {
    try {
      const { envelope } = validateBinaryEventOutbox(beforeEvent, beforeOutgoing);

      nativeRetryId = await computeBinaryRetryId(beforeOutgoing.payloadBytes);

      if (beforeOutgoing.nativeRetryId !== nativeRetryId || await computeEnvelopeHash(envelope) !== receipt.eventHash) return false;
    } catch { return false; }
  } else if (beforeEvent.envelopeFormat !== undefined || beforeEvent.envelopeJson !== beforeOutgoing.ciphertext) return false;

  if (!commit) { await access.assertMain();

 return true; }

  const receiptId = `delivered:${receipt.messageId}`;
  const previousReceipt = await access.db.receipts.get(receiptId);

  if (receipt.logicalDelivered && previousReceipt?.logicalDelivered_enc &&
      !samePayloadBytes(canonicalBytes(await decryptJsonRecord<LogicalDelivered>(access.key, receiptId, "receipt", previousReceipt.logicalDelivered_enc)),
        canonicalBytes(receipt.logicalDelivered))) return false;

  const logicalDelivered_enc = receipt.logicalDelivered ? previousReceipt?.logicalDelivered_enc ??
    await encryptJsonRecord(access.key, receiptId, "receipt", receipt.logicalDelivered) : undefined;

  const candidate = application ? await access.db.events.get(application.eventId) : undefined;

  if (application && (!candidate || candidate.eventHash !== application.eventHash ||
      candidate.localConvId !== receipt.convId || candidate.convId !== application.wireConvId ||
      candidate.bodyType !== "rcpt" || !candidate.applicationCryptoCommitted ||
      candidate.ratchetVersion !== 2 || candidate.lamport !== application.lamport || !Number.isSafeInteger(application.lamport))) return false;

  // All crypto, reads and binding validation precede the DB-only callback.
  const plan = Object.freeze({ ...receipt, humanId, humanConvId, application: application ? Object.freeze({ ...application }) : undefined,
    messageCiphertext: beforeMessage.enc_b64,
    candidateCiphertext: candidate?.authenticatedBody_enc, ts: Date.now() });

  const applied = await writeVault(access, [access.db.outbox, access.db.events, access.db.receipts, access.db.messages, access.db.meta], async () => {
    const outgoing = await access.db.outbox.get(plan.messageId);
    const event = await access.db.events.get(plan.messageId);
    const currentMessage = await access.db.messages.get(plan.humanId);

    if (!outgoing || outgoing.ownerAccountId !== access.accountId || outgoing.convId !== plan.convId ||
        outgoing.recipientIdentityPub !== plan.peerIdentityPub || !event ||
        (event.envelopeFormat === "nkce-v1" ? event.localConvId : event.convId) !== plan.convId ||
        event.eventHash !== plan.eventHash || outgoing.retention === "transient" || outgoing.binaryTransport || !sameOutboxPayload(outgoing, beforeOutgoing) ||
        !sameStoredCiphertext(currentMessage?.enc_b64, plan.messageCiphertext) || currentMessage?.convId !== plan.humanConvId) throw new Error("OWNER_APPLICATION_CONFLICT");

    if (outgoing.payloadFormat === "nkcp-v2") {
      validateBinaryEventOutbox(event, outgoing);

      if (event.envelopeFormat !== "nkce-v1" || beforeEvent.envelopeFormat !== "nkce-v1" ||
          !samePayloadBytes(event.envelopeBytes, beforeEvent.envelopeBytes)) throw new Error("OWNER_APPLICATION_CONFLICT");
    }
    else if (event.envelopeFormat !== undefined || event.envelopeJson !== outgoing.ciphertext) throw new Error("OWNER_APPLICATION_CONFLICT");

    if (plan.application) {
      const current = await access.db.events.get(plan.application.eventId);

      if (!current || current.eventHash !== plan.application.eventHash || current.localConvId !== plan.convId ||
          current.convId !== plan.application.wireConvId || current.bodyType !== "rcpt" ||
          !current.applicationCryptoCommitted || current.ratchetVersion !== 2 || current.lamport !== plan.application.lamport ||
          !sameStoredCiphertext(current.authenticatedBody_enc, plan.candidateCiphertext)) throw new Error("OWNER_APPLICATION_CONFLICT");

      if (current.applicationState !== "stored" && !plan.candidateCiphertext) throw new Error("RECEIVE_COMMIT_INCOMPLETE");
    }

    const id = `delivered:${outgoing.id}`;
    const existing = await access.db.receipts.get(id);

    if (JSON.stringify(existing) !== JSON.stringify(previousReceipt)) throw new Error("OWNER_APPLICATION_CONFLICT");

    if (existing && (existing.convId !== plan.humanConvId || existing.msgId !== plan.humanId || existing.kind !== "delivered" || existing.nativeRetryId !== nativeRetryId)) {
      throw new Error("OWNER_APPLICATION_CONFLICT");
    }

    if (!existing) {
      await access.db.receipts.put({ id, convId: plan.humanConvId, msgId: plan.humanId, kind: "delivered", ts: plan.ts, logicalDelivered_enc, nativeRetryId });
    }

    const keepCancellation = outgoing.payloadFormat === "nkcp-v2" && outgoing.status === "expired" && outgoing.lastError === "LOCAL_SOURCE_CANCELLED";
    await access.db.outbox.update(outgoing.id, { status: keepCancellation ? "expired" : "acked", ackDeadlineMs: undefined,
      inFlightAtMs: undefined, lastError: keepCancellation ? outgoing.lastError : undefined,
      nativeRetryStopped: outgoing.payloadFormat === "nkcp-v2" && (keepCancellation || outgoing.status === "acked") ? outgoing.nativeRetryStopped : false });

    if (plan.application) {
      await access.db.events.update(plan.application.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `lamport_v1:${plan.application.wireConvId}`;
      const current = Number((await access.db.meta.get(key))?.value ?? 0);
      await access.db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, plan.application.lamport)) });
    }

    return true;
  });

  // Native completion is outside the DB transaction. The existing acked row
  // remains the retry source if IPC fails or this generation is revoked.
  await reconcileAcknowledgedNativeRetries(access, [plan.messageId]);

  return applied;
};

export const reconcileAcknowledgedNativeRetries = async (access: VaultAccess, ids?: string[], replayStopped = false) => {
  const eligible = (row: OutboxRecord) => row.ownerAccountId === access.accountId && (replayStopped || !row.nativeRetryStopped) &&
    (row.status === "acked" || row.status === "expired" && (row.lastError === "LOCAL_SOURCE_CANCELLED" || row.lastError === "SESSION_SUPERSEDED"));

  const confirm = typeof window !== "undefined" ? window.nkc?.confirmOnionApplicationReceipt : undefined;
  const cancel = typeof window !== "undefined" ? window.nkc?.cancelOnionApplicationRetry : undefined;
  const supersede = typeof window !== "undefined" ? window.nkc?.supersedeOnionApplicationRetry : undefined;

  if (!confirm && !cancel && !supersede) {
    await access.assertMain();

    if (ids) return !(await access.db.outbox.bulkGet(ids)).some(row => row?.payloadFormat === "nkcp-v2" && eligible(row));

    for (const status of ["acked", "expired"] as const) {
      const rows = await access.db.outbox.where("status").equals(status)
        .filter(row => row.payloadFormat === "nkcp-v2" && eligible(row))
        .limit(1).toArray();

      if (rows.length) return false;
    }

    return true;
  }

  await access.assertMain();
  let complete = true;

  // Restart replay scans all terminal rows in bounded pages; ordinary ticks keep the existing 20-row limit.
  const batches = async function* () {
    if (ids) {
      yield (await access.db.outbox.bulkGet(ids)).filter((row): row is OutboxRecord => !!row);

      return;
    }

    for (const status of ["acked", "expired"] as const) {
      const query = access.db.outbox.where("status").equals(status).filter(eligible);

      for (let offset = 0;; offset += 20) {
        let rows: OutboxRecord[];

        if (replayStopped) rows = await query.clone().offset(offset).limit(20).toArray();
        else {
          let cursors = nativeReconcileCursors.get(access.db);

          if (!cursors) { cursors = new Map<string, string>(); nativeReconcileCursors.set(access.db, cursors); }

          const key = `${access.accountId}:${status}`, after = cursors.get(key);
          rows = await (after ? query.clone().and(row => row.id > after) : query).limit(20).toArray();

          if (!rows.length && after) rows = await query.limit(20).toArray();

          if (rows.length) cursors.set(key, rows[rows.length - 1].id);
          else cursors.delete(key);
        }

        yield rows;

        if (!replayStopped || rows.length < 20) break;
      }
    }
  };

  for await (const rows of batches()) for (const candidate of rows) {
    // Snapshot custody across IPC; a late write must not mutate the comparison baseline.
    const row = candidate.payloadFormat === "nkcp-v2" ? { ...candidate, payloadBytes: candidate.payloadBytes.slice() } : { ...candidate };
    const cancelled = row.status === "expired" && row.lastError === "LOCAL_SOURCE_CANCELLED";
    const superseded = row.status === "expired" && row.lastError === "SESSION_SUPERSEDED";
    let binaryEvent: EventRecord | undefined, binaryReceipt: ReceiptRecord | undefined;

    if (row.status !== "acked" && !cancelled && !superseded || row.ownerAccountId !== access.accountId || row.nativeRetryStopped && !replayStopped) continue;

    const unchanged = (current: OutboxRecord | undefined) => current?.ownerAccountId === access.accountId &&
      sameOutboxPayload(current, row) && current.status === row.status && current.lastError === row.lastError;

    try {
      await access.assertMain();

      if (row.payloadFormat === "nkcp-v2") {
        if (row.nativeRetryId !== await computeBinaryRetryId(row.payloadBytes) || decodeBinaryTransportPacketV2(row.payloadBytes).id !== row.id) { complete = false; continue; }

        if (row.status === "acked") {
          const event = await access.db.events.get(row.id);
          const receipt = await access.db.receipts.get(`${row.binaryTransport ? "media-stored" : "delivered"}:${row.id}`);

          if (!event || receipt?.nativeRetryId !== row.nativeRetryId || receipt.kind !== (row.binaryTransport ? "media_stored" : "delivered")) { complete = false; continue; }

          validateBinaryEventOutbox(event, row);
          binaryEvent = event;
          binaryReceipt = receipt;
        }
      }

      if (row.binaryTransport && row.status === "acked") {
        const receipt = await access.db.receipts.get(`media-stored:${row.id}`);

        if (!row.transferId || receipt?.kind !== "media_stored" || receipt.msgId !== row.transferId || receipt.convId !== row.convId) { complete = false; continue; }
      }

      if (!unchanged(await access.db.outbox.get(row.id))) { complete = false; continue; }

      if (await (superseded ? supersede : cancelled ? cancel : confirm)?.(access.session, row.id,
        row.payloadFormat === "nkcp-v2" ? row.payloadBytes : legacyOutboxCiphertext(row))) {
        const committed = await writeVault(access, [access.db.outbox, access.db.events, access.db.receipts], async () => {
          if (!unchanged(await access.db.outbox.get(row.id))) return false;

          if (binaryEvent) {
            const current = await access.db.events.get(row.id);

            if (!current || current.eventHash !== binaryEvent.eventHash) return false;
            validateBinaryEventOutbox(current, row);

            if (binaryReceipt && JSON.stringify(await access.db.receipts.get(binaryReceipt.id)) !== JSON.stringify(binaryReceipt)) return false;
          }

          await access.db.outbox.update(row.id, { nativeRetryStopped: true });

          return true;
        });

        if (!committed) complete = false;
      } else complete = false;
    } catch {
      complete = false;
      access.assertLocal(); // Leave the original terminal row for the next owned tick.
    }
  }

  return complete;
};

/** Preserve cancellation custody until the exact owner/ciphertext native fence commits. */
export const cancelInvalidatedOutgoing = async (record: OutboxRecord, access: VaultAccess) => {
  await writeVault(access, [access.db.outbox], async () => {
    const current = await access.db.outbox.get(record.id);

    if (!current || current.status === "acked" || current.ownerAccountId !== access.accountId || !sameOutboxPayload(current, record)) return;
    await access.db.outbox.update(record.id, { status: "expired", lastError: "LOCAL_SOURCE_CANCELLED", nativeRetryStopped: false });
  });
  await reconcileAcknowledgedNativeRetries(access, [record.id]);
};

export const onAckReceived = async (messageId: string) => {
  // Ordinary production delivery is certified only by an authenticated encrypted receipt.
  if (typeof window !== "undefined" && window.nkc?.activateAccountSession) return;

  try {
    const record = await getOutbox(messageId);

    if (record?.payloadFormat !== undefined) return;

    if (record) {
      if (record.retention === "transient") {
        if (record.transferId && Number.isInteger(record.chunkIndex)) {
          try {
            await markMediaTransferAcked(record.transferId, record.chunkIndex!);
          } catch (error) {
            console.warn("[delivery] failed to persist media ACK cursor", error);
          }
        }

        await deleteOutbox(messageId);
      } else {
        await updateOutbox(messageId, { status: "acked" });
      }

      const receipt: ReceiptRecord = {
        id: `delivered:${messageId}`,
        convId: record.convId,
        msgId: messageId,
        kind: "delivered",
        ts: Date.now(),
      };

      await putReceipt(receipt);
    }
  } catch (error) {
    console.warn("[delivery] ack cleanup failed", error);
  }
};

export const sweepExpired = async (now = Date.now(), access?: VaultAccess) => deleteExpiredOutbox(now, access);
