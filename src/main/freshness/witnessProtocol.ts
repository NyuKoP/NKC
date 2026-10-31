import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalBytes } from "../../crypto/canonicalJson";

export const MAX_WITNESS_BODY = 256 * 1024;
export type AuthorityTransition = {
  version: 1; rootId: string; rootPublicKey: string;
  previousEpoch: number; previousCommitment: string | null;
  nextEpoch: number; nextCommitment: string; recoveryBlobDigest: string; transitionNonce: string;
};
export type SignedTransition = { transition: AuthorityTransition; rootSignature: string; encryptedRecoveryCheckpoint: string };
export type WitnessCheckpoint = {
  version: 1; rootId: string; authorityEpoch: number; authorityCommitment: string | null;
  recoveryBlobDigest: string | null; transitionDigest: string | null; challenge: string;
};
export type WitnessResponse = { checkpoint: WitnessCheckpoint; record: SignedTransition | null; witnessSignature: string };
export const witnessDigest = (domain: string, value: unknown) => createHash("sha256")
  .update(domain + "\0").update(canonicalBytes(value)).digest("base64url");
export const validBytes = (value: unknown, size: number): value is string => typeof value === "string" &&
  /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === size &&
  Buffer.from(value, "base64url").toString("base64url") === value;
export const freshnessRootId = (publicKey: string) => {
  if (!validBytes(publicKey, 32)) throw new Error("WITNESS_ROOT_INVALID");

  return witnessDigest("nkc:freshness-root:v1", publicKey);
};
export const verifyWitnessSignature = (domain: string, value: unknown, signature: string, publicKey: string) => {
  if (!validBytes(signature, 64) || !validBytes(publicKey, 32)) return false;

  return verify(null, Buffer.concat([Buffer.from(domain + "\0"), canonicalBytes(value)]),
    createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" }),
    Buffer.from(signature, "base64url"));
};
export const validateSignedTransition = (input: unknown): SignedTransition => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("WITNESS_TRANSITION_INVALID");
  const record = input as SignedTransition, t = record.transition;

  if (Object.keys(record).sort().join() !== "encryptedRecoveryCheckpoint,rootSignature,transition" || !t ||
      Object.keys(t).sort().join() !== "nextCommitment,nextEpoch,previousCommitment,previousEpoch,recoveryBlobDigest,rootId,rootPublicKey,transitionNonce,version" ||
      t.version !== 1 || !Number.isSafeInteger(t.previousEpoch) || t.previousEpoch < 0 ||
      !Number.isSafeInteger(t.nextEpoch) || t.nextEpoch !== t.previousEpoch + 1 ||
      !validBytes(t.rootId, 32) || !validBytes(t.nextCommitment, 32) || !validBytes(t.recoveryBlobDigest, 32) ||
      !validBytes(t.transitionNonce, 32) || (t.previousEpoch === 0 ? t.previousCommitment !== null : !validBytes(t.previousCommitment, 32)) ||
      typeof record.encryptedRecoveryCheckpoint !== "string" || record.encryptedRecoveryCheckpoint.length < 64 ||
      record.encryptedRecoveryCheckpoint.length > 192 * 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(record.encryptedRecoveryCheckpoint) ||
      Buffer.from(record.encryptedRecoveryCheckpoint, "base64url").toString("base64url") !== record.encryptedRecoveryCheckpoint ||
      freshnessRootId(t.rootPublicKey) !== t.rootId ||
      witnessDigest("nkc:recovery-blob:v1", record.encryptedRecoveryCheckpoint) !== t.recoveryBlobDigest ||
      !verifyWitnessSignature("nkc:authority-transition:v1", t, record.rootSignature, t.rootPublicKey)) {
    throw new Error("WITNESS_TRANSITION_INVALID");
  }

  return record;
};

export const validateWitnessResponse = (input: unknown, rootId: string, challenge: string, publicKey: string): WitnessResponse => {
  if (!input || typeof input !== "object") throw new Error("WITNESS_RESPONSE_INVALID");
  const response = input as WitnessResponse, c = response.checkpoint;

  if (!c || c.version !== 1 || c.rootId !== rootId || c.challenge !== challenge || !validBytes(challenge, 32) ||
      !Number.isSafeInteger(c.authorityEpoch) || c.authorityEpoch < 0 ||
      !verifyWitnessSignature("nkc:witness-checkpoint:v1", c, response.witnessSignature, publicKey)) throw new Error("WITNESS_RESPONSE_INVALID");

  if (c.authorityEpoch === 0) {
    if (response.record !== null || c.authorityCommitment !== null || c.recoveryBlobDigest !== null || c.transitionDigest !== null) throw new Error("WITNESS_RESPONSE_INVALID");
  } else {
    const record = validateSignedTransition(response.record), t = record.transition;

    if (t.rootId !== rootId || t.nextEpoch !== c.authorityEpoch || t.nextCommitment !== c.authorityCommitment ||
        t.recoveryBlobDigest !== c.recoveryBlobDigest || witnessDigest("nkc:signed-transition:v1", record) !== c.transitionDigest) throw new Error("WITNESS_RESPONSE_INVALID");
  }

  return response;
};
