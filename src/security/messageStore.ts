import type { Conversation, Message, UserProfile } from "../db/repo";
import { listEventsByConv, listMessagesByConv } from "../db/repo";
import {
  decryptEnvelope,
  deriveConversationKey,
  type Envelope,
  verifyEnvelopeSignature,
} from "../crypto/box";
import { tryRecvDhKey, tryRecvKey } from "../crypto/ratchet";
import { getFriendPsk } from "./pskStore";
import { decodeBase64Url } from "./base64url";
import { getDhPrivateKey, getIdentityPublicKey } from "./identityKeys";
import { getOrCreateDeviceId } from "./deviceRole";

const logDecrypt = (label: string, meta: { convId: string; eventId: string; mode: string }) => {
  console.debug(`[msg] ${label}`, meta);
};

const resolveSenderId = (
  header: Envelope["header"],
  currentUserId: string,
  friendId: string
) => {
  const localDeviceId = getOrCreateDeviceId();
  return header.authorDeviceId === localDeviceId ? currentUserId : friendId;
};

export const loadConversationMessages = async (
  conv: Conversation,
  friend: UserProfile | null,
  currentUserId: string
) => {
  const legacy = await listMessagesByConv(conv.id).catch(() => []);

  if (!friend?.dhPub || !friend?.identityPub) {
    return legacy;
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

  for (const record of eventRecords) {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(record.envelopeJson) as Envelope;
    } catch (error) {
      console.warn("[msg] invalid envelope json", { convId: record.convId, eventId: record.eventId }, error);
      continue;
    }

    const senderId = resolveSenderId(envelope.header, currentUserId, friend.id);
    const verifyKey = senderId === currentUserId ? myIdentityPub : theirIdentityPub;

    try {
      const rk = envelope.header.rk;
      if (rk && rk.v === 2 && Number.isFinite(rk.i) && typeof rk.dh === "string") {
        const verified = await verifyEnvelopeSignature(envelope, verifyKey);
        if (!verified) {
          console.warn("[msg] signature invalid", { convId: record.convId, eventId: record.eventId });
          continue;
        }
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
        }>(recv.msgKey, envelope, verifyKey);

        if (!body || body.type !== "msg") continue;

        logDecrypt("commit", { convId: record.convId, eventId: record.eventId, mode: "v2" });
        await recv.commit();
        messages.push({
          id: envelope.header.eventId,
          convId: conv.id,
          senderId,
          text: body.text,
          ts: envelope.header.ts,
          media: body.media,
        });
        continue;
      }

      if (rk && rk.v === 1 && Number.isFinite(rk.i)) {
        const verified = await verifyEnvelopeSignature(envelope, verifyKey);
        if (!verified) {
          console.warn("[msg] signature invalid", { convId: record.convId, eventId: record.eventId });
          continue;
        }
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
        }>(recv.msgKey, envelope, verifyKey);

        if (!body || body.type !== "msg") continue;

        logDecrypt("ok", { convId: record.convId, eventId: record.eventId, mode: "v1" });
        messages.push({
          id: envelope.header.eventId,
          convId: conv.id,
          senderId,
          text: body.text,
          ts: envelope.header.ts,
          media: body.media,
        });
        continue;
      }

      logDecrypt("path", { convId: record.convId, eventId: record.eventId, mode: "legacy" });
      const body = await decryptEnvelope<{
        type: "msg";
        text: string;
        media?: Message["media"];
      }>(legacyKey, envelope, verifyKey);

      if (!body || body.type !== "msg") continue;

      logDecrypt("ok", { convId: record.convId, eventId: record.eventId, mode: "legacy" });
      messages.push({
        id: envelope.header.eventId,
        convId: conv.id,
        senderId,
        text: body.text,
        ts: envelope.header.ts,
        media: body.media,
      });
    } catch (error) {
      console.warn(
        "[msg] decrypt failed",
        { convId: record.convId, eventId: record.eventId },
        error
      );
    }
  }

  messages.sort((a, b) => a.ts - b.ts);
  return messages;
};
