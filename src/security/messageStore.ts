import type { Conversation, Message, UserProfile } from "../db/repo";
import { listMessageRecordsByConv } from "../db/repo";
import { decryptEnvelope, deriveConversationKey, type Envelope } from "../crypto/box";
import { getFriendPsk } from "./pskStore";
import { decodeBase64Url } from "./base64url";
import { getDhPrivateKey, getIdentityPublicKey } from "./identityKeys";
import { getOrCreateDeviceId } from "./deviceRole";

const buildPlaceholder = (
  convId: string,
  messageId: string,
  senderId: string,
  ts: number
): Message => ({
  id: messageId,
  convId,
  senderId,
  text: "복호화 실패",
  ts,
});

const resolveSenderId = (
  header: Envelope["header"],
  currentUserId: string,
  friendId: string
) => {
  const localDeviceId = getOrCreateDeviceId();
  return header.senderDeviceId === localDeviceId ? currentUserId : friendId;
};

export const loadConversationMessages = async (
  conv: Conversation,
  friend: UserProfile | null,
  currentUserId: string
) => {
  const records = await listMessageRecordsByConv(conv.id);
  if (!friend?.dhPub || !friend?.identityPub) {
    return records.map((item) => {
      if (item.kind === "legacy") return item.record;
      return buildPlaceholder(
        conv.id,
        item.record.id,
        friend?.id ?? currentUserId,
        item.record.ts
      );
    });
  }

  const dhPriv = await getDhPrivateKey();
  const theirDhPub = decodeBase64Url(friend.dhPub);
  const pskBytes = await getFriendPsk(friend.friendId ?? friend.id);
  const contextBytes = new TextEncoder().encode(`conv:${friend.friendId ?? friend.id}`);
  const conversationKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, contextBytes);
  const myIdentityPub = await getIdentityPublicKey();
  const theirIdentityPub = decodeBase64Url(friend.identityPub);

  const messages: Message[] = [];
  for (const item of records) {
    if (item.kind === "legacy") {
      messages.push(item.record);
      continue;
    }
    const envelope = item.record.envelope;
    const senderId = resolveSenderId(envelope.header, currentUserId, friend.id);
    const verifyKey =
      senderId === currentUserId ? myIdentityPub : theirIdentityPub;
    try {
      const body = await decryptEnvelope<{
        type: "msg";
        text: string;
        media?: Message["media"];
      }>(conversationKey, envelope, verifyKey);
      if (!body || body.type !== "msg") {
        messages.push(buildPlaceholder(conv.id, envelope.header.msgId, senderId, envelope.header.ts));
        continue;
      }
      messages.push({
        id: envelope.header.msgId,
        convId: conv.id,
        senderId,
        text: body.text,
        ts: envelope.header.ts,
        media: body.media,
      });
    } catch {
      messages.push(buildPlaceholder(conv.id, envelope.header.msgId, senderId, envelope.header.ts));
    }
  }
  return messages;
};
