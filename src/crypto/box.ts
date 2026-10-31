import { canonicalBytes, parseCanonicalBytes } from "./canonicalJson";
import { encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import { binaryEnvelopePlaintextLimit } from "./binaryEnvelope";
import { validateBinaryMediaBody } from "./binaryMediaBody";

export type EnvelopeHeader = {
  v: 1;
  convId: string;
  eventId: string;
  authorDeviceId: string;
  ts: number;
  lamport: number;
  /** New body codecs are authenticated by the existing header AAD and signature. */
  bodyCodec?: "canonical-json-v1" | "media-chunk-v1";
  prev?: string;
  /** Authenticated certificate-free fresh session; never inferred from a stored ratchet. */
  friendSessionId?: string;
  friendDeliveryId?: string;
  rk?: { v: 1; i: number } | { v: 2; i: number; dh: string; pn?: number };
  /** Explicit opt-in device delivery; covered by signature and AEAD header. */
  deviceDelivery?: { v: 2; recipientDeviceId: string;
    author: import("../devices/deviceApprovals").DeviceAuthorization; sessionId?: string; deliveryId?: string };
};

export type Envelope = {
  header: EnvelopeHeader;
  ciphertext: string;
  nonce: string;
  sig: string;
};

export type EnvelopeBytes = {
  header: EnvelopeHeader;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  sig: Uint8Array;
};

export type IncomingEnvelope = Envelope | EnvelopeBytes;

export const isRawEnvelope = (envelope: IncomingEnvelope): envelope is EnvelopeBytes =>
  envelope.nonce instanceof Uint8Array && envelope.ciphertext instanceof Uint8Array && envelope.sig instanceof Uint8Array;

export const isEnvelopeLike = (value: unknown): value is Envelope => {
  if (!value || typeof value !== "object" || !("header" in value)) return false;
  const header = value.header;

  if (!header || typeof header !== "object") return false;

  return "convId" in header && typeof header.convId === "string" &&
    "eventId" in header && typeof header.eventId === "string" &&
    "authorDeviceId" in header && typeof header.authorDeviceId === "string" &&
    "ts" in header && Number.isFinite(header.ts) &&
    "lamport" in header && Number.isFinite(header.lamport) &&
    "ciphertext" in value && typeof value.ciphertext === "string" &&
    "nonce" in value && typeof value.nonce === "string" && "sig" in value && typeof value.sig === "string";
};

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

const conversationKeyDomain = textEncoder.encode("nkc-conv-v1");

const concatBytes = (chunks: readonly Uint8Array[]) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
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

  const material = concatBytes([
    conversationKeyDomain,
    shared,
    pskBytes && pskBytes.length ? pskBytes : new Uint8Array(),
    contextBytes ?? new Uint8Array(),
  ]);

  return sodium.crypto_generichash(32, material);
};

export const deriveConversationKeyPair = async (
  myDhPriv: Uint8Array,
  theirDhPub: Uint8Array,
  pskBytes: Uint8Array | null | undefined,
  legacyContextBytes: Uint8Array,
  ratchetContextBytes: Uint8Array
) => {
  const sodium = await getSodium();
  const shared = sodium.crypto_scalarmult(myDhPriv, theirDhPub);

  const derive = (contextBytes: Uint8Array) => sodium.crypto_generichash(32, concatBytes([
    conversationKeyDomain,
    shared,
    pskBytes && pskBytes.length ? pskBytes : new Uint8Array(),
    contextBytes,
  ]));

  return {
    conversationKey: derive(legacyContextBytes),
    ratchetBaseKey: derive(ratchetContextBytes),
  };
};

const encryptBytes = async (
  keyOrMsgKey: Uint8Array,
  headerObj: EnvelopeHeader,
  plainBytes: Uint8Array,
  myIdentityPriv: Uint8Array
) => {
  const sodium = await getSodium();
  const headerBytes = canonicalBytes(headerObj);

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

  return { header: structuredClone(headerObj), ciphertext, nonce, sig } satisfies EnvelopeBytes;
};

export const encryptEnvelope = async (
  keyOrMsgKey: Uint8Array, header: EnvelopeHeader, body: unknown, myIdentityPriv: Uint8Array
) => {
  if (header.bodyCodec !== undefined) throw new Error("BINARY_BODY_CODEC_REQUIRES_BINARY_ENVELOPE");
  const sodium = await getSodium();
  const result = await encryptBytes(keyOrMsgKey, structuredClone(header), canonicalBytes(body), myIdentityPriv);

  return { header: result.header, ciphertext: toB64(sodium, result.ciphertext),
    nonce: toB64(sodium, result.nonce), sig: toB64(sodium, result.sig) } satisfies Envelope;
};

export const encryptEnvelopeBytes = async (
  keyOrMsgKey: Uint8Array, header: EnvelopeHeader, body: Uint8Array, myIdentityPriv: Uint8Array
) => {
  if (header.bodyCodec !== "canonical-json-v1" && header.bodyCodec !== "media-chunk-v1") {
    throw new Error("BINARY_BODY_CODEC_REQUIRED");
  }

  if (!(body instanceof Uint8Array) || body.byteLength > binaryEnvelopePlaintextLimit(header)) throw new Error("INVALID_BINARY_BODY");

  if (header.bodyCodec === "canonical-json-v1") parseCanonicalBytes(body);
  else validateBinaryMediaBody(body);

  return encryptBytes(keyOrMsgKey, structuredClone(header), body.slice(), myIdentityPriv);
};

const decryptBytes = async (
  keyOrMsgKey: Uint8Array,
  envelope: EnvelopeBytes,
  theirIdentityPub: Uint8Array
) => {
  const headerBytes = canonicalBytes(envelope.header);

  if (!(envelope.nonce instanceof Uint8Array) || !(envelope.sig instanceof Uint8Array) || !(envelope.ciphertext instanceof Uint8Array) ||
    envelope.nonce.length !== 24 || envelope.sig.length !== 64 || envelope.ciphertext.length < 16) {
    throw new Error("INVALID_BINARY_ENVELOPE");
  }

  const nonce = envelope.nonce.slice(), ciphertext = envelope.ciphertext.slice(), sig = envelope.sig.slice();
  const signed = concatBytes([headerBytes, nonce, ciphertext]);
  const sodium = await getSodium();
  const ok = sodium.crypto_sign_verify_detached(sig, signed, theirIdentityPub);

  if (!ok) throw new Error("Signature verification failed");

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    headerBytes,
    nonce,
    keyOrMsgKey
  );

};

export const decryptEnvelopeBytes = async (key: Uint8Array, envelope: EnvelopeBytes, identity: Uint8Array,
  expectedCodec: "legacy-json-v1" | NonNullable<EnvelopeHeader["bodyCodec"]>) => {
  if ((envelope.header.bodyCodec ?? "legacy-json-v1") !== expectedCodec) throw new Error("BINARY_BODY_CODEC_MISMATCH");

  if (envelope.ciphertext.length > binaryEnvelopePlaintextLimit(envelope.header) + 16) throw new Error("INVALID_BINARY_ENVELOPE");
  const body = await decryptBytes(key, envelope, identity);

  if (expectedCodec === "canonical-json-v1") parseCanonicalBytes(body);
  else if (expectedCodec === "media-chunk-v1") validateBinaryMediaBody(body);

  return body;
};

export const decryptEnvelope = async <T>(key: Uint8Array, envelope: IncomingEnvelope, identity: Uint8Array) => {
  if (isRawEnvelope(envelope)) {
    const plain = await decryptEnvelopeBytes(key, envelope, identity, "canonical-json-v1");

    return JSON.parse(textDecoder.decode(plain)) as T;
  }

  if (envelope.header.bodyCodec !== undefined) throw new Error("BINARY_BODY_CODEC_REQUIRES_BINARY_ENVELOPE");
  const sodium = await getSodium();

  const plain = await decryptBytes(key, { header: envelope.header, nonce: fromB64(sodium, envelope.nonce),
    ciphertext: fromB64(sodium, envelope.ciphertext), sig: fromB64(sodium, envelope.sig) }, identity);

  return JSON.parse(textDecoder.decode(plain)) as T;
};

export const verifyEnvelopeSignature = async (
  envelope: Envelope | EnvelopeBytes,
  theirIdentityPub: Uint8Array
) => {
  const sodium = await getSodium();
  const headerBytes = canonicalBytes(envelope.header);
  const nonce = envelope.nonce instanceof Uint8Array ? envelope.nonce : fromB64(sodium, envelope.nonce);
  const ciphertext = envelope.ciphertext instanceof Uint8Array ? envelope.ciphertext : fromB64(sodium, envelope.ciphertext);
  const sig = envelope.sig instanceof Uint8Array ? envelope.sig : fromB64(sodium, envelope.sig);
  const signed = concatBytes([headerBytes, nonce, ciphertext]);

  return sodium.crypto_sign_verify_detached(sig, signed, theirIdentityPub);
};

export const computeEnvelopeHashBytes = async (envelope: Pick<EnvelopeBytes, "header" | "nonce" | "ciphertext">) => {
  const material = concatBytes([canonicalBytes(envelope.header), envelope.nonce, envelope.ciphertext]);
  const sodium = await getSodium();

  return sodium.crypto_generichash(32, material);
};

export const computeEnvelopeHash = async (envelope: Envelope | EnvelopeBytes) => {
  const sodium = await getSodium();
  const nonce = envelope.nonce instanceof Uint8Array ? envelope.nonce : fromB64(sodium, envelope.nonce);
  const ciphertext = envelope.ciphertext instanceof Uint8Array ? envelope.ciphertext : fromB64(sodium, envelope.ciphertext);
  const hash = await computeEnvelopeHashBytes({ header: envelope.header, nonce, ciphertext });

  return encodeBase64Url(hash);
};
