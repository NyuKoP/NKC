import type { Conversation, Message, UserProfile } from "../db/repo";
import { listEventsByConv, listMessagesByConv } from "../db/repo";
import {
  decryptEnvelope,
  deriveConversationKey,
  type Envelope,
  verifyEnvelopeSignature,
} from "../crypto/box";
import { tryRecvDhKey, tryRecvKey } from "../crypto/ratchet";
import { encodeBinaryEnvelope } from "../crypto/vault";
import { getVaultKey } from "../crypto/sessionKeyring";
import { getFriendPsk } from "./pskStore";
import { decodeBase64Url } from "./base64url";
import { getDhPrivateKey, getIdentityPublicKey } from "./identityKeys";
import { db, ensureDbOpen } from "../db/schema";
import { putReadCursor, putReceipt } from "../storage/receiptStore";
import { applyGroupEvent, isGroupEventPayload } from "../sync/groupSync";

const logDecrypt = (label: string, meta: { convId: string; eventId: string; mode: string }) => {
  console.debug(`[msg] ${label}`, meta);
};

type SenderResolution = { senderId: string; verifyKey: Uint8Array } | null;

const determineSenderAndKey = async (
  envelope: Envelope,
  currentUserId: string,
  friendId: string,
  myIdentityPub: Uint8Array,
  theirIdentityPub: Uint8Array
): Promise<SenderResolution> => {
  if (await verifyEnvelopeSignature(envelope, myIdentityPub)) {
    return { senderId: currentUserId, verifyKey: myIdentityPub };
  }
  if (await verifyEnvelopeSignature(envelope, theirIdentityPub)) {
    return { senderId: friendId, verifyKey: theirIdentityPub };
  }
  return null;
};

const storeReadReceipt = async (
  convId: string,
  msgId: string,
  ts: number,
  actorId: string
) => {
  await putReceipt({
    id: `read:${msgId}:${actorId}`,
    convId,
    msgId,
    kind: "read",
    ts,
    actorId,
  });
};

const storeMediaChunk = async (payload: {
  ownerType?: "message" | "group";
  ownerId: string;
  idx: number;
  total: number;
  mime: string;
  b64: string;
}) => {
  const vk = getVaultKey();
  if (!vk) return;
  if (!Number.isFinite(payload.idx) || !Number.isFinite(payload.total)) return;
  if (payload.idx < 0 || payload.total <= 0) return;
  const ownerType = payload.ownerType === "group" ? "group" : "message";
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(payload.b64);
  } catch {
    return;
  }
  const chunkId = `${ownerType}:${payload.ownerId}:${payload.idx}`;
  await ensureDbOpen();
  const enc_b64 = await encodeBinaryEnvelope(vk, chunkId, "mediaChunk", bytes);
  await db.mediaChunks.put({
    id: chunkId,
    ownerType,
    ownerId: payload.ownerId,
    idx: payload.idx,
    enc_b64,
    mime: payload.mime,
    total: payload.total,
    updatedAt: Date.now(),
  });
};

export const loadConversationMessages = async (
  conv: Conversation,
  friend: UserProfile | null,
  currentUserId: string
) => {
  const legacy = await listMessagesByConv(conv.id).catch(() => []);
  await ensureDbOpen();
  const tombstones = await db.tombstones
    .where("type")
    .equals("message")
    .toArray()
    .catch(() => []);
  const tombstoneIds = new Set(tombstones.map((item) => item.id));

  if (!friend?.dhPub || !friend?.identityPub) {
    return tombstoneIds.size
      ? legacy.filter((message) => !tombstoneIds.has(message.id))
      : legacy;
  }

  const dhPriv = await getDhPrivateKey();
  const theirDhPub = decodeBase64Url(friend.dhPub);
  const pskBytes = await getFriendPsk(friend.friendId ?? friend.id);
  const legacyContextBytes = new TextEncoder().encode(`direct:${friend.friendId ?? friend.id}`);
  const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
  const legacyKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, legacyContextBytes);
  const ratchetBaseKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, ratchetContextBytes);

  const myIdentityPub = await getIdentityPublicKey();
  const theirIdentityPub = decodeBase64Url(friend.identityPub);

  const eventRecords = await listEventsByConv(conv.id).catch(() => []);
  const messages: Message[] = [...legacy];

  const handleBody = async (
    body: unknown,
    senderId: string,
    ts: number,
    messageId: string
  ): Promise<Message | null> => {
    if (!body || typeof body !== "object") return null;
    const typed = body as {
      type?: string;
      text?: string;
      media?: Message["media"];
      clientBatchId?: string;
      kind?: string;
      msgId?: string;
      convId?: string;
      ts?: number;
      cursorTs?: number;
      anchorMsgId?: string;
      phase?: string;
      ownerType?: string;
      ownerId?: string;
      idx?: number;
      total?: number;
      mime?: string;
      b64?: string;
    };

    if (isGroupEventPayload(body)) {
      await applyGroupEvent(body, senderId, currentUserId);
      return null;
    }

    if (typed.type === "msg") {
      return {
        id: messageId,
        convId: conv.id,
        senderId,
        text: typed.text ?? "",
        ts,
        media: typed.media,
        clientBatchId: typed.clientBatchId,
      };
    }

    if (typed.type === "rcpt" && typed.kind === "read" && typeof typed.msgId === "string") {
      await storeReadReceipt(typed.convId ?? conv.id, typed.msgId, typed.ts ?? ts, senderId);
      return null;
    }

    if (typed.type === "rcpt" && typed.kind === "read_cursor") {
      const targetConvId = typed.convId ?? conv.id;
      const cursorTsCandidate = Number.isFinite(typed.cursorTs)
        ? Number(typed.cursorTs)
        : typed.ts ?? ts;
      if (!Number.isFinite(cursorTsCandidate)) return null;
      const cursorTs = cursorTsCandidate;
      await putReadCursor({
        convId: targetConvId,
        actorId: senderId,
        cursorTs,
        anchorMsgId: typed.anchorMsgId ?? typed.msgId,
      });
      return null;
    }

    if (
      typed.type === "media" &&
      typed.phase === "chunk" &&
      typeof typed.ownerId === "string" &&
      typeof typed.b64 === "string"
    ) {
      await storeMediaChunk({
        ownerType: typed.ownerType === "group" ? "group" : "message",
        ownerId: typed.ownerId,
        idx: Number(typed.idx),
        total: Number(typed.total),
        mime: typeof typed.mime === "string" ? typed.mime : "application/octet-stream",
        b64: typed.b64,
      });
      return null;
    }

    return null;
  };

  for (const record of eventRecords) {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(record.envelopeJson) as Envelope;
    } catch (error) {
      console.warn("[msg] invalid envelope json", { convId: record.convId, eventId: record.eventId }, error);
      continue;
    }

    const resolved = await determineSenderAndKey(
      envelope,
      currentUserId,
      friend.id,
      myIdentityPub,
      theirIdentityPub
    );
    if (!resolved) {
      console.warn("[msg] signature invalid for both keys", {
        convId: record.convId,
        eventId: record.eventId,
      });
      continue;
    }
    const { senderId, verifyKey } = resolved;

    try {
      const rk = envelope.header.rk;
      if (rk && rk.v === 2 && Number.isFinite(rk.i) && typeof rk.dh === "string") {
        logDecrypt("path", { convId: record.convId, eventId: record.eventId, mode: "v2" });
        const recv = await tryRecvDhKey(conv.id, ratchetBaseKey, rk);
        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: record.convId, eventId: record.eventId, mode: "v2" });
          messages.push({
            id: envelope.header.eventId,
            convId: conv.id,
            senderId,
            text: "복호화 보류",
            ts: envelope.header.ts,
          });
          continue;
        }
        const body = await decryptEnvelope<{
          type: "msg";
          text: string;
          media?: Message["media"];
          clientBatchId?: string;
        }>(recv.msgKey, envelope, verifyKey);

        logDecrypt("commit", { convId: record.convId, eventId: record.eventId, mode: "v2" });
        await recv.commit();
        const message = await handleBody(
          body,
          senderId,
          envelope.header.ts,
          envelope.header.eventId
        );
        if (message) messages.push(message);
        continue;
      }

      if (rk && rk.v === 1 && Number.isFinite(rk.i)) {
        logDecrypt("path", { convId: record.convId, eventId: record.eventId, mode: "v1" });
        const recv = await tryRecvKey(conv.id, ratchetBaseKey, rk.i);
        if ("deferred" in recv) {
          logDecrypt("deferred", { convId: record.convId, eventId: record.eventId, mode: "v1" });
          messages.push({
            id: envelope.header.eventId,
            convId: conv.id,
            senderId,
            text: "복호화 보류",
            ts: envelope.header.ts,
          });
          continue;
        }
        const body = await decryptEnvelope<{
          type: "msg";
          text: string;
          media?: Message["media"];
          clientBatchId?: string;
        }>(recv.msgKey, envelope, verifyKey);

        logDecrypt("ok", { convId: record.convId, eventId: record.eventId, mode: "v1" });
        const message = await handleBody(
          body,
          senderId,
          envelope.header.ts,
          envelope.header.eventId
        );
        if (message) messages.push(message);
        continue;
      }

      logDecrypt("path", { convId: record.convId, eventId: record.eventId, mode: "legacy" });
      const body = await decryptEnvelope<{
        type: "msg";
        text: string;
        media?: Message["media"];
        clientBatchId?: string;
      }>(legacyKey, envelope, verifyKey);

      logDecrypt("ok", { convId: record.convId, eventId: record.eventId, mode: "legacy" });
      const message = await handleBody(
        body,
        senderId,
        envelope.header.ts,
        envelope.header.eventId
      );
      if (message) messages.push(message);
    } catch (error) {
      console.warn(
        "[msg] decrypt failed",
        { convId: record.convId, eventId: record.eventId },
        error
      );
    }
  }

  messages.sort((a, b) => a.ts - b.ts);
  return tombstoneIds.size
    ? messages.filter((message) => !tombstoneIds.has(message.id))
    : messages;
};
