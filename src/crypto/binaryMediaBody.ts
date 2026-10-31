import { canonicalBytes } from "./canonicalJson";
import { INLINE_MEDIA_CHUNK_SIZE, INLINE_MEDIA_MAX_BYTES } from "../net/mediaTransferLimits";

export type BinaryMediaMetadata = {
  type: "media";
  phase: "chunk";
  ownerId: string;
  idx: number;
  total: number;
  size: number;
  chunkSize: number;
  mime: string;
  name?: string;
  ownerType?: "message" | "group";
  clientBatchId?: string;
};

const MAGIC = new Uint8Array([0x4e, 0x4b, 0x43, 0x4d, 1]);

const PREFIX_BYTES = 13;

const MAX_METADATA_BYTES = 64 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

const allowedFields = new Set(["type", "phase", "ownerId", "idx", "total", "size", "chunkSize", "mime", "name", "ownerType", "clientBatchId"]);

const validateMetadata = (value: unknown, byteLength: number): BinaryMediaMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowedFields.has(key))) {
    throw new Error("INVALID_BINARY_MEDIA_METADATA");
  }

  const metadata = value as BinaryMediaMetadata;

  if (metadata.type !== "media" || metadata.phase !== "chunk" || typeof metadata.ownerId !== "string" ||
    !metadata.ownerId || metadata.ownerId.length > 256 || typeof metadata.mime !== "string" || metadata.mime.length > 256 ||
    !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > INLINE_MEDIA_MAX_BYTES ||
    metadata.chunkSize !== INLINE_MEDIA_CHUNK_SIZE || !Number.isSafeInteger(metadata.total) ||
    metadata.total !== Math.ceil(metadata.size / metadata.chunkSize) || !Number.isSafeInteger(metadata.idx) ||
    metadata.idx < 0 || metadata.idx >= metadata.total ||
    byteLength !== Math.min(metadata.chunkSize, metadata.size - metadata.idx * metadata.chunkSize) ||
    metadata.name !== undefined && (typeof metadata.name !== "string" || metadata.name.length > 1024) ||
    metadata.clientBatchId !== undefined && (typeof metadata.clientBatchId !== "string" || metadata.clientBatchId.length > 256) ||
    metadata.ownerType !== undefined && metadata.ownerType !== "message" && metadata.ownerType !== "group") {
    throw new Error("INVALID_BINARY_MEDIA_METADATA");
  }

  return metadata;
};

/** Must be encrypted under a header explicitly authenticating bodyCodec=media-chunk-v1. */
export const encodeBinaryMediaBody = (metadata: BinaryMediaMetadata, chunk: Uint8Array): Uint8Array => {
  if (!(chunk instanceof Uint8Array)) throw new Error("INVALID_BINARY_MEDIA_BYTES");
  const header = canonicalBytes(validateMetadata(metadata, chunk.length));

  if (header.length > MAX_METADATA_BYTES) throw new Error("BINARY_MEDIA_METADATA_TOO_LARGE");
  const result = new Uint8Array(PREFIX_BYTES + header.length + chunk.length);
  result.set(MAGIC);
  const view = new DataView(result.buffer);
  view.setUint32(5, header.length, false);
  view.setUint32(9, chunk.length, false);
  result.set(header, PREFIX_BYTES);
  result.set(chunk, PREFIX_BYTES + header.length);

  return result;
};

const parseBody = (bytes: Uint8Array): { metadata: BinaryMediaMetadata; chunkOffset: number } => {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX_BYTES || bytes.length > PREFIX_BYTES + MAX_METADATA_BYTES + INLINE_MEDIA_CHUNK_SIZE ||
    !MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error("INVALID_BINARY_MEDIA_FORMAT");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint32(5, false), chunkLength = view.getUint32(9, false);

  if (!metadataLength || metadataLength > MAX_METADATA_BYTES || chunkLength > INLINE_MEDIA_CHUNK_SIZE ||
    PREFIX_BYTES + metadataLength + chunkLength !== bytes.length) throw new Error("INVALID_BINARY_MEDIA_LENGTH");
  const encodedMetadata = bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength);
  const metadata = validateMetadata(JSON.parse(decoder.decode(encodedMetadata)), chunkLength);
  const canonical = canonicalBytes(metadata);

  if (canonical.length !== metadataLength || !canonical.every((byte, index) => byte === encodedMetadata[index])) {
    throw new Error("NON_CANONICAL_BINARY_MEDIA_METADATA");
  }

  return { metadata, chunkOffset: PREFIX_BYTES + metadataLength };
};

export const validateBinaryMediaBody = (bytes: Uint8Array): void => { parseBody(bytes); };

export const decodeBinaryMediaBody = (bytes: Uint8Array): { metadata: BinaryMediaMetadata; chunk: Uint8Array } => {
  const { metadata, chunkOffset } = parseBody(bytes);

  return { metadata, chunk: bytes.slice(chunkOffset) };
};
