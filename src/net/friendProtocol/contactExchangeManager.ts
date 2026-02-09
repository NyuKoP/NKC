import { canonicalBytes } from "../../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";
import type {
  BriarContactExchangeRecord,
  BriarHandshakeRecord,
  HandshakeFrameInput,
  ProtocolVerifyResult,
} from "./types";

const toProfileRecord = (frame: HandshakeFrameInput) => ({
  displayName: frame.profile?.displayName ?? "",
  status: frame.profile?.status ?? "",
  avatarRef: frame.profile?.avatarRef ?? null,
  friendCode: frame.from.friendCode ?? "",
});

const toKeyCommitmentRecord = (frame: HandshakeFrameInput, transcriptHash: string) => ({
  identityPub: frame.from.identityPub,
  dhPub: frame.from.dhPub,
  deviceId: frame.from.deviceId ?? "",
  transcriptHash,
});

const buildProfileHash = async (frame: HandshakeFrameInput) => {
  const sodium = await getSodium();
  return encodeBase64Url(sodium.crypto_generichash(32, canonicalBytes(toProfileRecord(frame))));
};

const buildKeyCommitment = async (frame: HandshakeFrameInput, transcriptHash: string) => {
  const sodium = await getSodium();
  return encodeBase64Url(
    sodium.crypto_generichash(32, canonicalBytes(toKeyCommitmentRecord(frame, transcriptHash)))
  );
};

export const buildContactExchangeRecord = async (
  frame: HandshakeFrameInput,
  handshake: BriarHandshakeRecord,
  identityPriv: Uint8Array
): Promise<BriarContactExchangeRecord> => {
  const sodium = await getSodium();
  const profileHash = await buildProfileHash(frame);
  const keyCommitment = await buildKeyCommitment(frame, handshake.transcriptHash);
  const signedPayload = canonicalBytes({
    profileHash,
    keyCommitment,
    transcriptHash: handshake.transcriptHash,
  });
  const profileSig = encodeBase64Url(sodium.crypto_sign_detached(signedPayload, identityPriv));
  return {
    v: 1,
    profileHash,
    keyCommitment,
    profileSig,
  };
};

export const verifyContactExchangeRecord = async (
  frame: HandshakeFrameInput,
  handshake: BriarHandshakeRecord,
  record: BriarContactExchangeRecord
): Promise<ProtocolVerifyResult> => {
  if (record.v !== 1) return { ok: false, reason: "contact-version" };
  try {
    const sodium = await getSodium();
    const expectedProfileHash = await buildProfileHash(frame);
    if (record.profileHash !== expectedProfileHash) {
      return { ok: false, reason: "contact-profile-hash" };
    }
    const expectedKeyCommitment = await buildKeyCommitment(frame, handshake.transcriptHash);
    if (record.keyCommitment !== expectedKeyCommitment) {
      return { ok: false, reason: "contact-key-commitment" };
    }
    const signedPayload = canonicalBytes({
      profileHash: record.profileHash,
      keyCommitment: record.keyCommitment,
      transcriptHash: handshake.transcriptHash,
    });
    const verifyKey = decodeBase64Url(frame.from.identityPub);
    const sig = decodeBase64Url(record.profileSig);
    const ok = sodium.crypto_sign_verify_detached(sig, signedPayload, verifyKey);
    return ok ? { ok: true } : { ok: false, reason: "contact-profile-sig" };
  } catch {
    return { ok: false, reason: "contact-verify-error" };
  }
};

