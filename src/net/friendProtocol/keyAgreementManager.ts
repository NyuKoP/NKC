import { canonicalBytes } from "../../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { decodeFriendCodeV1 } from "../../security/friendCode";
import { getDhPrivateKey, getDhPublicKey, getIdentityPublicKey } from "../../security/identityKeys";
import { getSodium } from "../../security/sodium";
import type {
  BriarContactExchangeRecord,
  BriarHandshakeRecord,
  BriarKeyAgreementRecord,
  FriendCodePayload,
  HandshakeFrameInput,
  ProtocolVerifyResult,
} from "./types";

const KEY_AGREEMENT_PROTOCOL_VERSION = 1;
const COMMIT_LABEL = "org.briarproject.bramble.keyagreement/COMMIT";
const SHARED_SECRET_LABEL = "org.briarproject.bramble.keyagreement/SHARED_SECRET";
const MASTER_KEY_LABEL = "org.briarproject.bramble.keyagreement/MASTER_SECRET";
const CONFIRMATION_KEY_LABEL = "org.briarproject.bramble.keyagreement/CONFIRMATION_KEY";
const CONFIRMATION_MAC_LABEL = "org.briarproject.bramble.keyagreement/CONFIRMATION_MAC";
const textEncoder = new TextEncoder();

type KeyAgreementBuildOptions = {
  pskHint?: string;
  localDhPriv?: Uint8Array;
  localFriendCode?: string;
  remoteFriendCode?: string;
  remoteIdentityPub?: string;
  remoteDhPub?: string;
  remoteDeviceId?: string;
  remoteOnionAddr?: string;
  remoteLokinetAddr?: string;
};

type KeyAgreementVerifyOptions = {
  localFriendCode?: string;
  localDhPriv?: Uint8Array;
};

type ResolvedPeer = {
  identityPub: string;
  dhPub: string;
  deviceId?: string;
  onionAddr?: string;
  lokinetAddr?: string;
};

const concatBytes = (chunks: Uint8Array[]) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

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

const decodeFriendCode = (code?: string) => {
  const value = code?.trim();
  if (!value) return null;
  const decoded = decodeFriendCodeV1(value);
  if ("error" in decoded) return null;
  return decoded;
};

const toPeerFromFriendCode = (code?: string): Partial<ResolvedPeer> => {
  const decoded = decodeFriendCode(code);
  if (!decoded) return {};
  return {
    identityPub: decoded.identityPub,
    dhPub: decoded.dhPub,
    deviceId: decoded.deviceId,
    onionAddr: decoded.onionAddr,
    lokinetAddr: decoded.lokinetAddr,
  };
};

const resolveLocalPeer = async (localFriendCode?: string): Promise<ResolvedPeer> => {
  const fromCode = toPeerFromFriendCode(localFriendCode);
  const identityPub = fromCode.identityPub ?? encodeBase64Url(await getIdentityPublicKey());
  const dhPub = fromCode.dhPub ?? encodeBase64Url(await getDhPublicKey());
  return {
    identityPub,
    dhPub,
    deviceId: fromCode.deviceId ?? getOrCreateDeviceId(),
    onionAddr: fromCode.onionAddr,
    lokinetAddr: fromCode.lokinetAddr,
  };
};

const resolveRemotePeer = (options?: KeyAgreementBuildOptions): ResolvedPeer | null => {
  const fromCode = toPeerFromFriendCode(options?.remoteFriendCode);
  const identityPub = options?.remoteIdentityPub ?? fromCode.identityPub;
  const dhPub = options?.remoteDhPub ?? fromCode.dhPub;
  if (!identityPub || !dhPub) return null;
  return {
    identityPub,
    dhPub,
    deviceId: options?.remoteDeviceId ?? fromCode.deviceId,
    onionAddr: options?.remoteOnionAddr ?? fromCode.onionAddr,
    lokinetAddr: options?.remoteLokinetAddr ?? fromCode.lokinetAddr,
  };
};

const deriveCommitmentBytes = async (dhPub: string) => {
  const sodium = await getSodium();
  const digest = sodium.crypto_generichash(
    32,
    concatBytes([textEncoder.encode(COMMIT_LABEL), decodeBase64Url(dhPub)])
  );
  return digest.slice(0, 16);
};

const compareBytes = (lhs: Uint8Array, rhs: Uint8Array) => {
  const min = Math.min(lhs.length, rhs.length);
  for (let i = 0; i < min; i += 1) {
    if (lhs[i] === rhs[i]) continue;
    return lhs[i] < rhs[i] ? -1 : 1;
  }
  if (lhs.length === rhs.length) return 0;
  return lhs.length < rhs.length ? -1 : 1;
};

const createPayload = async (peer: ResolvedPeer): Promise<FriendCodePayload> => {
  const commitment = encodeBase64Url(await deriveCommitmentBytes(peer.dhPub));
  return {
    v: 1,
    commitment,
    identityPub: peer.identityPub,
    dhPub: peer.dhPub,
    deviceId: peer.deviceId,
    onionAddr: peer.onionAddr,
    lokinetAddr: peer.lokinetAddr,
  };
};

export const encodeFriendCodePayload = (payload: FriendCodePayload) =>
  encodeBase64Url(canonicalBytes(payload));

export const parseFriendCodePayload = (encoded: string): FriendCodePayload | null => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Partial<FriendCodePayload>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.commitment !== "string" || !parsed.commitment.trim()) return null;
    if (typeof parsed.identityPub !== "string" || !parsed.identityPub.trim()) return null;
    if (typeof parsed.dhPub !== "string" || !parsed.dhPub.trim()) return null;
    return {
      v: 1,
      commitment: parsed.commitment,
      identityPub: parsed.identityPub,
      dhPub: parsed.dhPub,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      onionAddr: typeof parsed.onionAddr === "string" ? parsed.onionAddr : undefined,
      lokinetAddr: typeof parsed.lokinetAddr === "string" ? parsed.lokinetAddr : undefined,
    };
  } catch {
    return null;
  }
};

const resolveRole = async (localPayload: FriendCodePayload, remotePayload: FriendCodePayload) => {
  const localCommit = decodeBase64Url(localPayload.commitment);
  const remoteCommit = decodeBase64Url(remotePayload.commitment);
  const cmp = compareBytes(localCommit, remoteCommit);
  if (cmp < 0) return "alice" as const;
  if (cmp > 0) return "bob" as const;
  return localPayload.identityPub < remotePayload.identityPub ? ("alice" as const) : ("bob" as const);
};

const deriveSharedSecret = async (
  localDhPriv: Uint8Array,
  localDhPub: Uint8Array,
  remoteDhPub: Uint8Array,
  senderRole: "alice" | "bob"
) => {
  const sodium = await getSodium();
  const shared = sodium.crypto_scalarmult(localDhPriv, remoteDhPub);
  const alicePub = senderRole === "alice" ? localDhPub : remoteDhPub;
  const bobPub = senderRole === "alice" ? remoteDhPub : localDhPub;
  return sodium.crypto_generichash(
    32,
    concatBytes([
      textEncoder.encode(SHARED_SECRET_LABEL),
      shared,
      new Uint8Array([KEY_AGREEMENT_PROTOCOL_VERSION]),
      alicePub,
      bobPub,
    ])
  );
};

const deriveConfirmationV1 = async (
  sharedSecret: Uint8Array,
  localPayload: FriendCodePayload,
  remotePayload: FriendCodePayload,
  localDhPub: Uint8Array,
  remoteDhPub: Uint8Array,
  localRole: "alice" | "bob",
  senderRole: "alice" | "bob",
  context: Uint8Array
) => {
  const sodium = await getSodium();
  const ck = sodium.crypto_generichash(
    32,
    concatBytes([textEncoder.encode(CONFIRMATION_KEY_LABEL), sharedSecret])
  );
  const localPayloadBytes = canonicalBytes(localPayload);
  const remotePayloadBytes = canonicalBytes(remotePayload);
  const alicePayload = localRole === "alice" ? localPayloadBytes : remotePayloadBytes;
  const alicePub = localRole === "alice" ? localDhPub : remoteDhPub;
  const bobPayload = localRole === "alice" ? remotePayloadBytes : localPayloadBytes;
  const bobPub = localRole === "alice" ? remoteDhPub : localDhPub;
  const ordered =
    senderRole === "alice"
      ? [alicePayload, alicePub, bobPayload, bobPub]
      : [bobPayload, bobPub, alicePayload, alicePub];
  const confirmationBytes = sodium.crypto_generichash(
    32,
    concatBytes([textEncoder.encode(CONFIRMATION_MAC_LABEL), ck, ...ordered, context])
  );
  return encodeBase64Url(confirmationBytes);
};

const deriveMasterKeyHint = async (sharedSecret: Uint8Array) => {
  const sodium = await getSodium();
  const masterKey = sodium.crypto_generichash(
    32,
    concatBytes([textEncoder.encode(MASTER_KEY_LABEL), sharedSecret])
  );
  return encodeBase64Url(masterKey.slice(0, 12));
};

export const buildKeyAgreementRecord = async (
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  options?: KeyAgreementBuildOptions
): Promise<BriarKeyAgreementRecord> => {
  const nonce = await createNonce();
  const pskHint = options?.pskHint?.trim() || undefined;
  const remotePeer = resolveRemotePeer(options);
  if (!remotePeer) {
    const confirmation = await computeConfirmation(handshake, contact, nonce, pskHint);
    return {
      v: 1,
      method: "identity_dh",
      nonce,
      confirmation,
      pskHint,
    };
  }
  const localPeer = await resolveLocalPeer(options?.localFriendCode);
  const localPayload = await createPayload(localPeer);
  const remotePayload = await createPayload(remotePeer);
  const localRole = await resolveRole(localPayload, remotePayload);
  const context = canonicalBytes(
    toConfirmationPayload(handshake, contact, nonce, pskHint)
  );
  const localDhPriv = options?.localDhPriv ?? await getDhPrivateKey();
  const localDhPubBytes = decodeBase64Url(localPeer.dhPub);
  const remoteDhPubBytes = decodeBase64Url(remotePeer.dhPub);
  const sharedSecret = await deriveSharedSecret(
    localDhPriv,
    localDhPubBytes,
    remoteDhPubBytes,
    localRole
  );
  const confirmation = await deriveConfirmationV1(
    sharedSecret,
    localPayload,
    remotePayload,
    localDhPubBytes,
    remoteDhPubBytes,
    localRole,
    localRole,
    context
  );
  return {
    v: 1,
    method: "friend_code_oob_v1",
    nonce,
    confirmation,
    commitment: localPayload.commitment,
    payload: encodeFriendCodePayload(localPayload),
    role: localRole,
    masterKeyHint: await deriveMasterKeyHint(sharedSecret),
    pskHint,
  };
};

export const verifyKeyAgreementRecord = async (
  frame: HandshakeFrameInput,
  handshake: BriarHandshakeRecord,
  contact: BriarContactExchangeRecord,
  record: BriarKeyAgreementRecord,
  options?: KeyAgreementVerifyOptions
): Promise<ProtocolVerifyResult> => {
  if (record.v !== 1) return { ok: false, reason: "key-agreement-version" };
  const nonce = record.nonce?.trim();
  if (!nonce) return { ok: false, reason: "key-agreement-nonce" };
  if (record.method === "identity_dh") {
    const expected = await computeConfirmation(handshake, contact, nonce, record.pskHint);
    if (record.confirmation !== expected) {
      return { ok: false, reason: "key-agreement-confirmation" };
    }
    return { ok: true };
  }
  if (record.method !== "friend_code_oob_v1") {
    return { ok: false, reason: "key-agreement-method" };
  }
  if (!record.payload || !record.commitment || !record.role) {
    return { ok: false, reason: "key-agreement-payload-missing" };
  }
  const remotePayload = parseFriendCodePayload(record.payload);
  if (!remotePayload) return { ok: false, reason: "key-agreement-payload-parse" };
  if (remotePayload.identityPub !== frame.from.identityPub) {
    return { ok: false, reason: "key-agreement-identity-mismatch" };
  }
  if (remotePayload.dhPub !== frame.from.dhPub) {
    return { ok: false, reason: "key-agreement-dh-mismatch" };
  }
  const expectedRemoteCommit = encodeBase64Url(await deriveCommitmentBytes(frame.from.dhPub));
  if (record.commitment !== expectedRemoteCommit || remotePayload.commitment !== expectedRemoteCommit) {
    return { ok: false, reason: "key-agreement-commitment" };
  }
  const localPeer = await resolveLocalPeer(options?.localFriendCode);
  const localPayload = await createPayload(localPeer);
  const localRole = await resolveRole(localPayload, remotePayload);
  const expectedRemoteRole = localRole === "alice" ? "bob" : "alice";
  if (record.role !== expectedRemoteRole) {
    return { ok: false, reason: "key-agreement-role" };
  }
  const context = canonicalBytes(
    toConfirmationPayload(handshake, contact, nonce, record.pskHint)
  );
  const localDhPriv = options?.localDhPriv ?? await getDhPrivateKey();
  const localDhPubBytes = decodeBase64Url(localPeer.dhPub);
  const remoteDhPubBytes = decodeBase64Url(frame.from.dhPub);
  const sharedSecret = await deriveSharedSecret(
    localDhPriv,
    localDhPubBytes,
    remoteDhPubBytes,
    localRole
  );
  const expected = await deriveConfirmationV1(
    sharedSecret,
    localPayload,
    remotePayload,
    localDhPubBytes,
    remoteDhPubBytes,
    localRole,
    record.role,
    context
  );
  if (record.confirmation !== expected) {
    return { ok: false, reason: "key-agreement-confirmation" };
  }
  if (record.masterKeyHint) {
    const hint = await deriveMasterKeyHint(sharedSecret);
    if (hint !== record.masterKeyHint) {
      return { ok: false, reason: "key-agreement-master-key-hint" };
    }
  }
  return { ok: true };
};
