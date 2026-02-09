import { canonicalBytes } from "../../crypto/canonicalJson";
import { encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";
import type {
  BriarContactExchangeRecord,
  BriarHandshakeRecord,
  BriarKeyAgreementRecord,
  ProtocolVerifyResult,
} from "./types";

const createNonce = async () => {
  const sodium = await getSodium();
  const bytes = sodium.randombytes_buf(16);
  return encodeBase64Url(bytes);
};

const toConfirmationPayload = (
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  nonce: string,
  pskHint?: string
) => ({
  transcriptHash: handshake.transcriptHash,
  profileHash: contact.profileHash,
  keyCommitment: contact.keyCommitment,
  nonce,
  pskHint: pskHint ?? "",
});

const computeConfirmation = async (
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  nonce: string,
  pskHint?: string
) => {
  const sodium = await getSodium();
  const payloadBytes = canonicalBytes(toConfirmationPayload(handshake, contact, nonce, pskHint));
  return encodeBase64Url(sodium.crypto_generichash(32, payloadBytes));
};

export const buildKeyAgreementRecord = async (
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  options?: { pskHint?: string }
): Promise<BriarKeyAgreementRecord> => {
  const nonce = await createNonce();
  const pskHint = options?.pskHint?.trim() || undefined;
  const confirmation = await computeConfirmation(handshake, contact, nonce, pskHint);
  return {
    v: 1,
    method: "identity_dh",
    nonce,
    confirmation,
    pskHint,
  };
};

export const verifyKeyAgreementRecord = async (
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  record: BriarKeyAgreementRecord
): Promise<ProtocolVerifyResult> => {
  if (record.v !== 1) return { ok: false, reason: "key-agreement-version" };
  if (record.method !== "identity_dh") return { ok: false, reason: "key-agreement-method" };
  const nonce = record.nonce?.trim();
  if (!nonce) return { ok: false, reason: "key-agreement-nonce" };
  const expected = await computeConfirmation(handshake, contact, nonce, record.pskHint);
  if (record.confirmation !== expected) {
    return { ok: false, reason: "key-agreement-confirmation" };
  }
  return { ok: true };
};

