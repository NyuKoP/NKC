import { canonicalBytes } from "./canonicalJson";
import type { EnvelopeBytes, EnvelopeHeader } from "./box";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../net/mediaTransferLimits";

// This is a bounded, single-envelope format; it neither negotiates capabilities nor authenticates a sender.
const MAGIC = new Uint8Array([0x4e, 0x4b, 0x43, 0x45, 1]);

const PREFIX_BYTES = 13;

const NONCE_BYTES = 24;

const SIGNATURE_BYTES = 64;

const MAX_HEADER_BYTES = 64 * 1024;
// Reserve the largest NKCP v2 metadata/prefix; nested frames must fit the existing transport ceiling.

export const MAX_BINARY_ENVELOPE_BYTES = ONION_TRANSFER_MAX_BODY_BYTES - MAX_HEADER_BYTES - 13;

const decoder = new TextDecoder("utf-8", { fatal: true });

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const validateHeader = (value: unknown): EnvelopeHeader => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ENVELOPE_HEADER");
  const header = value as EnvelopeHeader;

  if (header.v !== 1 || ![header.convId, header.eventId, header.authorDeviceId].every(
    field => typeof field === "string" && field.length > 0 && field.length <= 256) ||
    !Number.isSafeInteger(header.ts) || header.ts < 0 || !Number.isSafeInteger(header.lamport) || header.lamport < 0 ||
    header.bodyCodec !== undefined && header.bodyCodec !== "canonical-json-v1" && header.bodyCodec !== "media-chunk-v1") {
    throw new Error("INVALID_ENVELOPE_HEADER");
  }

  return header;
};

export const binaryEnvelopePlaintextLimit = (header: EnvelopeHeader): number => {
  const length = canonicalBytes(validateHeader(header)).length;

  if (length > MAX_HEADER_BYTES) throw new Error("INVALID_BINARY_ENVELOPE_LENGTH");

  return MAX_BINARY_ENVELOPE_BYTES - PREFIX_BYTES - length - NONCE_BYTES - SIGNATURE_BYTES - 16;
};

export const encodeBinaryEnvelopeFrame = (envelope: EnvelopeBytes): Uint8Array => {
  if (!(envelope.nonce instanceof Uint8Array) || !(envelope.ciphertext instanceof Uint8Array) || !(envelope.sig instanceof Uint8Array)) {
    throw new Error("INVALID_BINARY_ENVELOPE_BYTES");
  }

  const header = canonicalBytes(validateHeader(envelope.header));
  const total = PREFIX_BYTES + header.length + NONCE_BYTES + envelope.ciphertext.length + SIGNATURE_BYTES;

  if (header.length > MAX_HEADER_BYTES || envelope.nonce.length !== NONCE_BYTES || envelope.sig.length !== SIGNATURE_BYTES ||
    envelope.ciphertext.length < 16 || total > MAX_BINARY_ENVELOPE_BYTES) throw new Error("INVALID_BINARY_ENVELOPE_LENGTH");
  const result = new Uint8Array(total);
  result.set(MAGIC);
  const view = new DataView(result.buffer);
  view.setUint32(5, header.length, false);
  view.setUint32(9, envelope.ciphertext.length, false);
  let offset = PREFIX_BYTES;

  for (const part of [header, envelope.nonce, envelope.ciphertext, envelope.sig]) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
};

export const decodeBinaryEnvelopeFrame = (bytes: Uint8Array): EnvelopeBytes => {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX_BYTES || bytes.length > MAX_BINARY_ENVELOPE_BYTES ||
    !MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error("INVALID_BINARY_ENVELOPE_FORMAT");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(5, false), ciphertextLength = view.getUint32(9, false);
  const nonceOffset = PREFIX_BYTES + headerLength;
  const ciphertextOffset = nonceOffset + NONCE_BYTES;
  const signatureOffset = ciphertextOffset + ciphertextLength;

  if (!headerLength || headerLength > MAX_HEADER_BYTES || ciphertextLength < 16 ||
    signatureOffset + SIGNATURE_BYTES !== bytes.length) throw new Error("INVALID_BINARY_ENVELOPE_LENGTH");
  const encodedHeader = bytes.subarray(PREFIX_BYTES, nonceOffset);
  const header = validateHeader(JSON.parse(decoder.decode(encodedHeader)));
  // Reject duplicate keys, alternate number spellings, whitespace and ambiguous JSON before crypto dispatch.

  if (!sameBytes(encodedHeader, canonicalBytes(header))) throw new Error("NON_CANONICAL_ENVELOPE_HEADER");

  return { header, nonce: bytes.slice(nonceOffset, ciphertextOffset),
    ciphertext: bytes.slice(ciphertextOffset, signatureOffset), sig: bytes.slice(signatureOffset) };
};
