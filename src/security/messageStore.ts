import type { Conversation, Message, UserProfile } from "../db/repo";
import { listEventsByConv, listMessagesByConv } from "../db/repo";
import { decryptEnvelope, deriveConversationKey, type Envelope } from "../crypto/box";
import { getFriendPsk } from "./pskStore";
import { decodeBase64Url } from "./base64url";
import { getDhPrivateKey, getIdentityPublicKey } from "./identityKeys";
import { getOrCreateDeviceId } from "./deviceRole";

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
  const contextBytes = new TextEncoder().encode(`direct:${friend.friendId ?? friend.id}`);
  const conversationKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, contextBytes);

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
      const body = await decryptEnvelope<{
        type: "msg";
        text: string;
        media?: Message["media"];
      }>(conversationKey, envelope, verifyKey);

      if (!body || body.type !== "msg") continue;

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

