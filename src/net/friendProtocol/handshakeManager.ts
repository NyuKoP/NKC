import { canonicalBytes } from "../../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";
import type {
  BriarHandshakeRecord,
  HandshakeFrameInput,
  ProtocolVerifyResult,
} from "./types";

const toTranscript = (frame: HandshakeFrameInput) => ({
  type: frame.type,
  convId: frame.convId ?? "",
  ts: Number.isFinite(frame.ts) ? frame.ts : 0,
  from: {
    identityPub: frame.from.identityPub,
    dhPub: frame.from.dhPub,
    deviceId: frame.from.deviceId ?? "",
  },
});

export const buildHandshakeRecord = async (
  frame: HandshakeFrameInput,
  identityPriv: Uint8Array
): Promise<BriarHandshakeRecord> => {
  const sodium = await getSodium();
  const transcriptBytes = canonicalBytes(toTranscript(frame));
  const transcriptHash = encodeBase64Url(sodium.crypto_generichash(32, transcriptBytes));
  const proofSig = encodeBase64Url(sodium.crypto_sign_detached(transcriptBytes, identityPriv));
  return {
    v: 1,
    transcriptHash,
    proofSig,
  };
};

export const verifyHandshakeRecord = async (
  frame: HandshakeFrameInput,
  record: BriarHandshakeRecord
): Promise<ProtocolVerifyResult> => {
  if (record.v !== 1) return { ok: false, reason: "handshake-version" };
  try {
    const sodium = await getSodium();
    const transcriptBytes = canonicalBytes(toTranscript(frame));
    const expectedHash = encodeBase64Url(sodium.crypto_generichash(32, transcriptBytes));
    if (record.transcriptHash !== expectedHash) {
      return { ok: false, reason: "handshake-transcript-hash" };
    }
    const verifyKey = decodeBase64Url(frame.from.identityPub);
    const proofSig = decodeBase64Url(record.proofSig);
    const ok = sodium.crypto_sign_verify_detached(proofSig, transcriptBytes, verifyKey);
    return ok ? { ok: true } : { ok: false, reason: "handshake-proof-sig" };
  } catch {
    return { ok: false, reason: "handshake-verify-error" };
  }
};

