import { canonicalBytes } from "./canonicalJson";
import { getSodium } from "../security/sodium";

export type EnvelopeHeader = {
  v: 1;
  convId: string;
  eventId: string;
  authorDeviceId: string;
  ts: number;
  lamport: number;
  rk?: { v: 1; i: number } | { v: 2; i: number; dh: string; pn?: number };
};

export type Envelope = {
  header: EnvelopeHeader;
  ciphertext: string;
  nonce: string;
  sig: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const concatBytes = (chunks: Array<Uint8Array | ArrayBuffer>) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return result;
};

const toB64 = (sodium: Awaited<ReturnType<typeof getSodium>>, bytes: Uint8Array) =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

const fromB64 = (sodium: Awaited<ReturnType<typeof getSodium>>, value: string) =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL);

export const deriveConversationKey = async (
  myDhPriv: Uint8Array,
  theirDhPub: Uint8Array,
  pskBytes?: Uint8Array | null,
  contextBytes?: Uint8Array
) => {
  const sodium = await getSodium();
  const shared = sodium.crypto_scalarmult(myDhPriv, theirDhPub);
  const domain = textEncoder.encode("nkc-conv-v1");
  const material = concatBytes([
    domain,
    shared,
    pskBytes && pskBytes.length ? pskBytes : new Uint8Array(),
    contextBytes ?? new Uint8Array(),
  ]);
  return sodium.crypto_generichash(32, material);
};

export const encryptEnvelope = async (
  keyOrMsgKey: Uint8Array,
  headerObj: EnvelopeHeader,
  plaintextObj: unknown,
  myIdentityPriv: Uint8Array
) => {
  const sodium = await getSodium();
  const headerBytes = canonicalBytes(headerObj);
  const plainBytes = canonicalBytes(plaintextObj);
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainBytes,
    headerBytes,
    null,
    nonce,
    keyOrMsgKey
  );
  const sig = sodium.crypto_sign_detached(
    concatBytes([headerBytes, nonce, ciphertext]),
    myIdentityPriv
  );
  return {
    header: headerObj,
    ciphertext: toB64(sodium, ciphertext),
    nonce: toB64(sodium, nonce),
    sig: toB64(sodium, sig),
  } satisfies Envelope;
};

export const decryptEnvelope = async <T>(
  keyOrMsgKey: Uint8Array,
  envelope: Envelope,
  theirIdentityPub: Uint8Array
) => {
  const sodium = await getSodium();
  const headerBytes = canonicalBytes(envelope.header);
  const nonce = fromB64(sodium, envelope.nonce);
  const ciphertext = fromB64(sodium, envelope.ciphertext);
  const sig = fromB64(sodium, envelope.sig);
  const signed = concatBytes([headerBytes, nonce, ciphertext]);
  const ok = sodium.crypto_sign_verify_detached(sig, signed, theirIdentityPub);
  if (!ok) throw new Error("Signature verification failed");
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    headerBytes,
    nonce,
    keyOrMsgKey
  );
  return JSON.parse(textDecoder.decode(plain)) as T;
};

export const verifyEnvelopeSignature = async (
  envelope: Envelope,
  theirIdentityPub: Uint8Array
) => {
  const sodium = await getSodium();
  const headerBytes = canonicalBytes(envelope.header);
  const nonce = fromB64(sodium, envelope.nonce);
  const ciphertext = fromB64(sodium, envelope.ciphertext);
  const sig = fromB64(sodium, envelope.sig);
  const signed = concatBytes([headerBytes, nonce, ciphertext]);
  return sodium.crypto_sign_verify_detached(sig, signed, theirIdentityPub);
};
