import { deriveConversationKey } from "./box";
import { canonicalBytes } from "./canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import type { DeviceAuthorization } from "../devices/deviceApprovals";
import { sameCertificate } from "../devices/securityState";

// Friend pins prove a key pair, never Root-issued device authorization.
export type FriendSessionIdentity = { kind: "FRIEND_BOUND"; identityPub: string; dhPub: string; deviceId: string };
export type SessionIdentity = DeviceAuthorization | FriendSessionIdentity;
export type SessionContribution = { authorization: SessionIdentity; nonce: string; ephemeral: string;
  ratchet: "receive-driven-v1" };
export type FreshSession = { id: string; key: Uint8Array; initiator: SessionIdentity; responder: SessionIdentity; createdAt: number };
export const sameSessionIdentity = (a: SessionIdentity, b: SessionIdentity) => a.kind === "FRIEND_BOUND" || b.kind === "FRIEND_BOUND"
  ? a.kind === b.kind && a.identityPub === b.identityPub && a.dhPub === b.dhPub && a.deviceId === b.deviceId
  : sameCertificate(a, b);
export const matchesFreshSession = (session: FreshSession, local: SessionIdentity, remote: SessionIdentity) =>
  [session.initiator, session.responder].some(cert => sameSessionIdentity(cert, local)) &&
  [session.initiator, session.responder].some(cert => sameSessionIdentity(cert, remote));
const confirmationBytes = (id: string) => canonicalBytes({ protocol: "nkc:session-ready:v1", sessionId: id });
const confirmationKey = async (session: FreshSession) => (await getSodium()).crypto_generichash(32,
  canonicalBytes({ protocol: "nkc:session-confirmation-key:v1", sessionId: session.id }), session.key);
export const confirmFreshSession = async (session: FreshSession) => {
  const sodium = await getSodium(), key = await confirmationKey(session);
  try { return encodeBase64Url(sodium.crypto_auth(confirmationBytes(session.id), key)); }
  finally { sodium.memzero(key); }
};
export const verifyFreshSessionConfirmation = async (session: FreshSession, confirmation: string) => {
  if (typeof confirmation !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(confirmation)) return false;
  const sodium = await getSodium(), key = await confirmationKey(session);
  try { return sodium.crypto_auth_verify(decodeBase64Url(confirmation), confirmationBytes(session.id), key); }
  catch { return false; }
  finally { sodium.memzero(key); }
};
export const freshRatchetChannel = (channel: string, sessionId: string) => `${channel}:session:${sessionId}`;
export const createSessionContribution = async <T extends SessionIdentity>(authorization: T) => {
  const sodium = await getSodium(), pair = sodium.crypto_box_keypair();
  return { privateKey: pair.privateKey, public: { authorization, nonce: encodeBase64Url(sodium.randombytes_buf(32)),
    ephemeral: encodeBase64Url(pair.publicKey), ratchet: "receive-driven-v1" } satisfies SessionContribution };
};
export const validateSessionContribution = (value: SessionContribution) => {
  if (!value || !value.authorization || !["DEVICE_ADDED", "FRIEND_BOUND"].includes(value.authorization.kind) ||
      value.ratchet !== "receive-driven-v1" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(value.ephemeral) ||
      encodeBase64Url(decodeBase64Url(value.nonce)) !== value.nonce || encodeBase64Url(decodeBase64Url(value.ephemeral)) !== value.ephemeral) {
    throw new Error("FRESH_SESSION_INVALID");
  }
};
/** Both contributions must first pass the signed control/current certificate boundary. */
export const agreeFreshSession = async (channel: string, initiator: SessionContribution, responder: SessionContribution,
  privateKey: Uint8Array, initiating: boolean): Promise<FreshSession> => {
  validateSessionContribution(initiator); validateSessionContribution(responder);
  if (initiator.authorization.deviceId === responder.authorization.deviceId) throw new Error("FRESH_SESSION_INVALID");
  const transcript = canonicalBytes({ protocol: "nkc:authenticated-session:v1", channel, initiator, responder });
  const id = encodeBase64Url((await getSodium()).crypto_hash_sha256(transcript));
  const key = await deriveConversationKey(privateKey, decodeBase64Url((initiating ? responder : initiator).ephemeral), null, transcript);
  return { id, key, initiator: initiator.authorization, responder: responder.authorization, createdAt: Date.now() };
};
