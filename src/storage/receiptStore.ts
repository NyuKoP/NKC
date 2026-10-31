import { db as activeDb } from "../db/schema";
import { ensureVaultAccess, writeVault, type VaultAccess } from "../db/vaultAccess";
import type { ReceiptRecord } from "../db/schema";
import { decryptJsonRecord, encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import type { Conversation, UserProfile, Message } from "../db/repo";
import { verifyLogicalDelivered, resolveAccountGroup, type LogicalDelivered, type LogicalRead } from "../sync/receivedText";
import { getStoredMessage } from "../db/repo";
import { captureLocalOperationContext, type ReceiveContext } from "../accounts/receiveContext";
import { getAccountRootIdentity, getAuthorizedDeviceRegistry } from "../devices/deviceApprovals";
import type { Envelope } from "../crypto/box";
import { canonicalBytes } from "../crypto/canonicalJson";
import { encodeBase64Url } from "../security/base64url";

export const putReceipt = async (receipt: ReceiptRecord, access?: VaultAccess) => {
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  await writeVault(access, [db.receipts], () => db.receipts.put(receipt));
};

/** Replicated storage proof alone cannot acknowledge an Outbox; that requires its bound application receipt. */
export const putLogicalDelivered = async (proof: LogicalDelivered, context: ReceiveContext,
  application?: { envelope: Envelope; eventHash: string }, validateOnly = false) => {
  const access = context.vault, db = access.db;

  if (!await verifyLogicalDelivered(proof, context)) throw new Error("DELIVERED_PROOF_INVALID");
  const message = await getStoredMessage(proof.logicalMessageId, access);

  if (!message?.logicalProof || message.logicalProof.conversationIdentity !== proof.conversationIdentity ||
      message.logicalProof.senderAccountIdentity !== proof.senderAccountIdentity ||
      message.logicalProof.groupId !== proof.groupId ||
      (!proof.groupId && message.logicalProof.recipientAccountIdentity !== proof.recipientAccountIdentity)) throw new Error("DELIVERED_TARGET_UNAVAILABLE");
  const beforeMessage = await db.messages.get(message.id), previous = await db.receipts.get(proof.id);

  if (previous && (previous.kind !== "delivered" || previous.msgId !== message.id || previous.convId !== message.convId ||
      previous.logicalDelivered_enc && encodeBase64Url(canonicalBytes(await decryptJsonRecord<LogicalDelivered>(access.key, previous.id, "receipt", previous.logicalDelivered_enc))) !== encodeBase64Url(canonicalBytes(proof)))) {
    throw new Error("DELIVERED_PROOF_CONFLICT");
  }

  if (validateOnly) { await access.assertMain();

 return true; }

  const beforeEvent = application ? await db.events.get(application.envelope.header.eventId) : undefined;

  if (application && (!beforeEvent?.authenticatedBody_enc || beforeEvent.eventHash !== application.eventHash ||
      !beforeEvent.applicationCryptoCommitted || beforeEvent.applicationState !== "pending")) throw new Error("DELIVERED_PROOF_CONFLICT");
  const logicalDelivered_enc = previous?.logicalDelivered_enc ?? await encryptJsonRecord(access.key, proof.id, "receipt", proof);

  return writeVault(access, [db.receipts, db.messages, db.events, db.meta], async () => {
    if (!sameStoredCiphertext((await db.messages.get(message.id))?.enc_b64, beforeMessage?.enc_b64) ||
        JSON.stringify(await db.receipts.get(proof.id)) !== JSON.stringify(previous)) throw new Error("DELIVERED_PROOF_CONFLICT");

    if (application) {
      const current = await db.events.get(application.envelope.header.eventId);

      if (current?.eventHash !== application.eventHash || !sameStoredCiphertext(current.authenticatedBody_enc, beforeEvent?.authenticatedBody_enc) ||
          !current.applicationCryptoCommitted || current.applicationState !== "pending") throw new Error("DELIVERED_PROOF_CONFLICT");
      await db.events.update(current.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `lamport_v1:${application.envelope.header.convId}`;
      const currentLamport = Number((await db.meta.get(key))?.value ?? 0);
      await db.meta.put({ key, value: String(Math.max(Number.isFinite(currentLamport) ? currentLamport : 0, application.envelope.header.lamport)) });
    }

    await db.receipts.put({ id: proof.id, msgId: message.id, convId: message.convId, kind: "delivered", ts: proof.ts, logicalDelivered_enc });

    return true;
  });
};

export const putReadCursor = async (payload: {
  convId: string;
  actorId: string;
  cursorTs: number;
  anchorMsgId?: string;
  logicalRead?: LogicalRead;
}, access?: VaultAccess, application?: { eventId: string; eventHash: string; lamport: number; wireConvId: string;
  peerIdentityPub: string; localUserId: string; validateOnly?: boolean; ownRead?: boolean }) => {
  if (!payload.convId || !payload.actorId || !Number.isFinite(payload.cursorTs)) return;
  const db = access?.db ?? activeDb;
  await ensureVaultAccess(access);
  const beforeEvent = application ? await db.events.get(application.eventId) : undefined;
  const beforeActor = application ? await db.profiles.get(payload.actorId) : undefined;
  const beforeConv = application ? await db.conversations.get(payload.convId) : undefined;
  const beforeAnchor = application && payload.anchorMsgId ? await db.messages.get(payload.anchorMsgId) : undefined;

  if (application) {
    if (!access || !beforeActor || !beforeConv || (!application.validateOnly && (!beforeEvent?.authenticatedBody_enc ||
        beforeEvent.eventHash !== application.eventHash || !beforeEvent.applicationCryptoCommitted ||
        beforeEvent.applicationState !== "pending"))) throw new Error("READ_CURSOR_APPLICATION_CONFLICT");
    const actor = await decryptJsonRecord<UserProfile>(access.key, beforeActor.id, "profile", beforeActor.enc_b64);
    const conv = await decryptJsonRecord<Conversation>(access.key, beforeConv.id, "conv", beforeConv.enc_b64);

    if ((!application.ownRead && actor.identityPub !== application.peerIdentityPub) || actor.friendStatus === "blocked" || actor.friendStatus === "deleted" ||
        actor.trust?.status === "blocked" || actor.trust?.status === "changed" ||
        (application.ownRead && (actor.kind !== "user" || actor.id !== application.localUserId)) ||
        !conv.participants.includes(actor.id) || !conv.participants.includes(application.localUserId)) throw new Error("READ_CURSOR_ACTOR_MISMATCH");

    if (payload.anchorMsgId) {
      if (!beforeAnchor || beforeAnchor.convId !== payload.convId) throw new Error("READ_CURSOR_TARGET_MISMATCH");
      const anchor = await decryptJsonRecord<Message>(access.key, beforeAnchor.id, "message", beforeAnchor.enc_b64);

      if (payload.logicalRead?.groupId ? anchor.logicalProof?.groupId !== payload.logicalRead.groupId || anchor.senderId === payload.actorId :
        application.ownRead ? anchor.senderId === application.localUserId : anchor.senderId !== application.localUserId) throw new Error("READ_CURSOR_TARGET_MISMATCH");
    }
  }

  const id = `read_cursor:${payload.convId}:${payload.actorId}`;
  const existing = await db.receipts.get(id);
  const nextCursorTs = Math.max(existing?.cursorTs ?? 0, payload.cursorTs);

  const logicalRead_enc = payload.logicalRead && access ?
    await encryptJsonRecord(access.key, id, "receipt", payload.logicalRead) : undefined;

  if (payload.logicalRead && !logicalRead_enc) throw new Error("OWNER_REQUIRED");

  const record: ReceiptRecord = {
    id,
    convId: payload.convId,
    msgId: payload.anchorMsgId ?? id,
    kind: "read_cursor",
    ts: Date.now(),
    actorId: payload.actorId,
    cursorTs: nextCursorTs,
    anchorMsgId: payload.anchorMsgId,
    logicalRead_enc,
  };

  if (application?.validateOnly) { access?.assertLocal();

 return true; }

  await writeVault(access, application ? [db.receipts, db.events, db.meta, db.profiles, db.conversations, db.messages] : [db.receipts], async () => {
    if (application) {
      const candidate = await db.events.get(application.eventId);

      if (candidate?.eventHash !== application.eventHash || !sameStoredCiphertext(candidate.authenticatedBody_enc, beforeEvent?.authenticatedBody_enc) ||
          candidate.applicationState !== "pending" || !candidate.applicationCryptoCommitted ||
          (await db.profiles.get(payload.actorId))?.enc_b64 !== beforeActor?.enc_b64 ||
          (await db.conversations.get(payload.convId))?.enc_b64 !== beforeConv?.enc_b64 ||
          (payload.anchorMsgId && !sameStoredCiphertext((await db.messages.get(payload.anchorMsgId))?.enc_b64, beforeAnchor?.enc_b64))) throw new Error("READ_CURSOR_APPLICATION_CONFLICT");
    }

    const current = await db.receipts.get(id);
    record.cursorTs = Math.max(current?.cursorTs ?? 0, nextCursorTs);

    if (current && (current.cursorTs ?? 0) > payload.cursorTs) {
      record.anchorMsgId = current.anchorMsgId;
      record.msgId = current.msgId;
      record.logicalRead_enc = current.logicalRead_enc;
    }

    await db.receipts.put(record);

    if (payload.anchorMsgId) await db.receipts.put({
      id: `read:${payload.anchorMsgId}:${payload.actorId}`,
      convId: payload.convId,
      msgId: payload.anchorMsgId,
      kind: "read",
      ts: record.cursorTs,
      actorId: payload.actorId,
    });

    if (application) {
      await db.events.update(application.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `lamport_v1:${application.wireConvId}`;
      const current = Number((await db.meta.get(key))?.value ?? 0);
      await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, application.lamport)) });
    }
  });

  return true;
};

export const getReceiptState = async (msgId: string) => {
  const context = await captureLocalOperationContext();
  const db = await ensureVaultAccess(context?.vault);
  const records = await db.receipts.where("msgId").equals(msgId).toArray();
  const message = context ? await getStoredMessage(msgId, context.vault) : null;

  if (context && message?.logicalProof && await getAccountRootIdentity(context)) {
    const group = message.logicalProof.groupId ? await resolveAccountGroup(message.logicalProof.groupId, context) : null;

    const recipientRoots = message.logicalProof.groupId ? group ? [...group.members.keys()].filter(root => root !== message.logicalProof!.senderAccountIdentity) : [] :
      [message.logicalProof.recipientAccountIdentity];

    const targets = (await Promise.all(recipientRoots.map(root => getAuthorizedDeviceRegistry(context, root)))).flatMap(registry => Object.values(registry))
      .filter(device => device.kind === "DEVICE_ADDED");

    const storedDevices = new Set<string>();

    for (const record of records) if (record.logicalDelivered_enc) {
      const proof = await decryptJsonRecord<LogicalDelivered>(context.vault.key, record.id, "receipt", record.logicalDelivered_enc);

      if (proof.logicalMessageId === msgId && proof.conversationIdentity === message.logicalProof.conversationIdentity &&
          proof.senderAccountIdentity === message.logicalProof.senderAccountIdentity &&
          proof.groupId === message.logicalProof.groupId && recipientRoots.includes(proof.recipientAccountIdentity) &&
          await verifyLogicalDelivered(proof, context)) storedDevices.add(proof.author.deviceId);
    }

    context.vault.assertLocal();
    const accountDelivered = recipientRoots.length > 0 && recipientRoots.every(root => targets.some(device => device.accountRootIdentityPub === root && storedDevices.has(device.deviceId)));

    return { delivered: accountDelivered, read: records.some(record => record.kind === "read"), accountDelivered,
      allDevicesSynced: targets.length > 0 && targets.every(device => storedDevices.has(device.deviceId)),
      deviceStorage: targets.map(device => ({ deviceId: device.deviceId, stored: storedDevices.has(device.deviceId) })),
      outboxStatus: accountDelivered ? undefined : "pending" as const };
  }

  return {
    delivered: records.some((record) => record.kind === "delivered"),
    read: records.some((record) => record.kind === "read"),
  };
};

export const listReceiptsByConv = async (convId: string) => {
  const db = await ensureVaultAccess();

  return db.receipts.where("convId").equals(convId).toArray();
};

export const getReadCursors = async (convId: string) => {
  const db = await ensureVaultAccess();

  const records = await db.receipts
    .where("[convId+kind]")
    .equals([convId, "read_cursor"])
    .toArray();

  const map: Record<string, number> = {};
  records.forEach((record) => {
    if (!record.actorId) return;
    const cursorTs = Number(record.cursorTs);

    if (!Number.isFinite(cursorTs)) return;
    const prev = map[record.actorId] ?? 0;

    if (cursorTs > prev) {
      map[record.actorId] = cursorTs;
    }
  });

  return map;
};
