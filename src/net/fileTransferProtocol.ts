import { getSodium } from "../security/sodium";
import { INLINE_MEDIA_CHUNK_SIZE, INLINE_MEDIA_MAX_BYTES } from "./mediaTransferLimits";

export const FILE_TRANSFER_DOMAIN = "nkc-file-transfer-v1";
export const FILE_TRANSFER_AAD_BYTES = 96;
export const FILE_TRANSFER_NONCE_BYTES = 24;
export const FILE_TRANSFER_TAG_BYTES = 16;
export const FILE_TRANSFER_MAX_FRAMES_PER_CHUNK = 64;
export const FILE_TRANSFER_MAX_INCOMPLETE_CHUNKS = 16;

const encoder = new TextEncoder();
const domainBytes = encoder.encode(FILE_TRANSFER_DOMAIN);

export type FileTransferDirection = "FORWARD" | "REVERSE";

export type FileTransferManifest = {
  version: 1;
  transferId: string;
  transferSalt: Uint8Array;
  senderDeviceId: string;
  receiverDeviceId: string;
  direction: FileTransferDirection;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: Uint8Array;
};

export type FileTransferMaterial = {
  key: Uint8Array;
  noncePrefix: Uint8Array;
};

export type FileTransportFrame = {
  protocolVersion: 1;
  transferId: string;
  chunkIndex: number;
  frameIndex: number;
  frameCount: number;
  ciphertextOffset: number;
  ciphertextLength: number;
  ciphertext: Uint8Array;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidToBytes(value: string): Uint8Array {
  if (!UUID_RE.test(value)) throw new Error("invalid canonical UUID");
  return Uint8Array.from(value.replaceAll("-", "").match(/.{2}/g)!, (part) => Number.parseInt(part, 16));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) throw new Error("uint32 out of range");
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function setU64(view: DataView, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("uint64 value is not a safe integer");
  view.setBigUint64(offset, BigInt(value), false);
}

export function validateFileTransferManifest(manifest: FileTransferManifest): void {
  uuidToBytes(manifest.transferId);
  uuidToBytes(manifest.senderDeviceId);
  uuidToBytes(manifest.receiverDeviceId);
  if (manifest.transferSalt.length !== 32) throw new Error("transferSalt must be 32 bytes");
  if (manifest.fileSha256.length !== 32) throw new Error("fileSha256 must be 32 bytes");
  if (manifest.chunkSize !== INLINE_MEDIA_CHUNK_SIZE) throw new Error("unsupported logical chunk size");
  if (!Number.isSafeInteger(manifest.fileSize) || manifest.fileSize <= 0 || manifest.fileSize > INLINE_MEDIA_MAX_BYTES) {
    throw new Error("fileSize out of range");
  }
  const expectedChunks = Math.ceil(manifest.fileSize / manifest.chunkSize);
  if (manifest.totalChunks !== expectedChunks || manifest.totalChunks >= 2 ** 32) {
    throw new Error("totalChunks does not match fileSize");
  }
}

export async function deriveFileTransferMaterial(
  sessionKey: Uint8Array,
  manifest: FileTransferManifest
): Promise<FileTransferMaterial> {
  validateFileTransferManifest(manifest);
  if (sessionKey.length < 32) throw new Error("sessionKey must be at least 32 bytes");
  const direction = Uint8Array.of(manifest.direction === "FORWARD" ? 0 : 1);
  const info = concat(
    domainBytes,
    uuidToBytes(manifest.transferId),
    uuidToBytes(manifest.senderDeviceId),
    uuidToBytes(manifest.receiverDeviceId),
    direction
  );
  const sessionKeyBuffer = new Uint8Array(sessionKey).buffer;
  const saltBuffer = new Uint8Array(manifest.transferSalt).buffer;
  const infoBuffer = new Uint8Array(info).buffer;
  const key = await crypto.subtle.importKey("raw", sessionKeyBuffer, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: saltBuffer,
    info: infoBuffer,
  }, key, 52 * 8));
  return { key: okm.slice(0, 32), noncePrefix: okm.slice(32, 52) };
}

export function buildFileChunkNonce(noncePrefix: Uint8Array, chunkIndex: number): Uint8Array {
  if (noncePrefix.length !== 20) throw new Error("noncePrefix must be 20 bytes");
  return concat(noncePrefix, u32(chunkIndex));
}

export function expectedPlaintextLength(manifest: FileTransferManifest, chunkIndex: number): number {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
    throw new Error("chunkIndex out of range");
  }
  const offset = chunkIndex * manifest.chunkSize;
  return Math.min(manifest.chunkSize, manifest.fileSize - offset);
}

export function buildFileChunkAad(
  manifest: FileTransferManifest,
  chunkIndex: number,
  plaintextLength: number
): Uint8Array {
  validateFileTransferManifest(manifest);
  const expectedLength = expectedPlaintextLength(manifest, chunkIndex);
  if (plaintextLength !== expectedLength) throw new Error("plaintextLength does not match chunk bounds");
  const aad = new Uint8Array(FILE_TRANSFER_AAD_BYTES);
  aad.set(domainBytes, 0);
  aad.set(uuidToBytes(manifest.transferId), 20);
  aad.set(uuidToBytes(manifest.senderDeviceId), 36);
  aad.set(uuidToBytes(manifest.receiverDeviceId), 52);
  const view = new DataView(aad.buffer);
  view.setUint32(68, chunkIndex, false);
  view.setUint32(72, manifest.totalChunks, false);
  setU64(view, 76, chunkIndex * manifest.chunkSize);
  view.setUint32(84, plaintextLength, false);
  setU64(view, 88, manifest.fileSize);
  return aad;
}

export async function encryptFileChunk(
  material: FileTransferMaterial,
  manifest: FileTransferManifest,
  chunkIndex: number,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const aad = buildFileChunkAad(manifest, chunkIndex, plaintext.length);
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, aad, null, buildFileChunkNonce(material.noncePrefix, chunkIndex), material.key
  );
}

export async function decryptFileChunk(
  material: FileTransferMaterial,
  manifest: FileTransferManifest,
  chunkIndex: number,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const expectedLength = expectedPlaintextLength(manifest, chunkIndex);
  if (ciphertext.length !== expectedLength + FILE_TRANSFER_TAG_BYTES) throw new Error("ciphertextLength does not match chunk bounds");
  const sodium = await getSodium();
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    buildFileChunkAad(manifest, chunkIndex, expectedLength),
    buildFileChunkNonce(material.noncePrefix, chunkIndex),
    material.key
  );
}

export function splitFileChunkFrames(
  transferId: string,
  chunkIndex: number,
  ciphertext: Uint8Array,
  frameSize: number
): FileTransportFrame[] {
  uuidToBytes(transferId);
  if (!Number.isSafeInteger(frameSize) || frameSize < 32 * 1024 || frameSize > 256 * 1024) throw new Error("invalid frameSize");
  const frameCount = Math.ceil(ciphertext.length / frameSize);
  if (frameCount < 1 || frameCount > FILE_TRANSFER_MAX_FRAMES_PER_CHUNK) throw new Error("frameCount out of range");
  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const ciphertextOffset = frameIndex * frameSize;
    const payload = ciphertext.slice(ciphertextOffset, Math.min(ciphertext.length, ciphertextOffset + frameSize));
    return { protocolVersion: 1, transferId, chunkIndex, frameIndex, frameCount, ciphertextOffset, ciphertextLength: ciphertext.length, ciphertext: payload };
  });
}

type PartialChunk = { length: number; frameCount: number; frames: Map<number, FileTransportFrame> };

export class FileFrameAssembler {
  private readonly chunks = new Map<string, PartialChunk>();

  push(frame: FileTransportFrame): Uint8Array | null {
    if (frame.protocolVersion !== 1) throw new Error("unsupported frame protocol version");
    uuidToBytes(frame.transferId);
    if (!Number.isSafeInteger(frame.chunkIndex) || frame.chunkIndex < 0 || frame.chunkIndex >= 2 ** 32) throw new Error("chunkIndex out of range");
    if (!Number.isSafeInteger(frame.frameCount) || frame.frameCount < 1 || frame.frameCount > FILE_TRANSFER_MAX_FRAMES_PER_CHUNK) throw new Error("frameCount out of range");
    if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex >= frame.frameCount) throw new Error("frameIndex out of range");
    if (!Number.isSafeInteger(frame.ciphertextLength) || frame.ciphertextLength <= FILE_TRANSFER_TAG_BYTES || frame.ciphertextLength > INLINE_MEDIA_CHUNK_SIZE + FILE_TRANSFER_TAG_BYTES) throw new Error("ciphertextLength out of range");
    if (!Number.isSafeInteger(frame.ciphertextOffset) || frame.ciphertextOffset < 0 || frame.ciphertext.length === 0 || frame.ciphertextOffset + frame.ciphertext.length > frame.ciphertextLength) throw new Error("frame bounds invalid");
    const key = `${frame.transferId}:${frame.chunkIndex}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (this.chunks.size >= FILE_TRANSFER_MAX_INCOMPLETE_CHUNKS) throw new Error("too many incomplete chunks");
      chunk = { length: frame.ciphertextLength, frameCount: frame.frameCount, frames: new Map() };
      this.chunks.set(key, chunk);
    }
    if (chunk.length !== frame.ciphertextLength || chunk.frameCount !== frame.frameCount) throw new Error("inconsistent frame metadata");
    const existing = chunk.frames.get(frame.frameIndex);
    if (existing) {
      if (existing.ciphertextOffset !== frame.ciphertextOffset || existing.ciphertext.length !== frame.ciphertext.length || !existing.ciphertext.every((v, i) => v === frame.ciphertext[i])) throw new Error("conflicting duplicate frame");
      return null;
    }
    for (const other of chunk.frames.values()) {
      const overlaps = frame.ciphertextOffset < other.ciphertextOffset + other.ciphertext.length && other.ciphertextOffset < frame.ciphertextOffset + frame.ciphertext.length;
      if (overlaps) throw new Error("overlapping frame ranges");
    }
    chunk.frames.set(frame.frameIndex, frame);
    if (chunk.frames.size !== chunk.frameCount) return null;
    const result = new Uint8Array(chunk.length);
    let covered = 0;
    for (const item of [...chunk.frames.values()].sort((a, b) => a.ciphertextOffset - b.ciphertextOffset)) {
      if (item.ciphertextOffset !== covered) throw new Error("frame ranges contain a gap");
      result.set(item.ciphertext, item.ciphertextOffset);
      covered += item.ciphertext.length;
    }
    if (covered !== result.length) throw new Error("frame ranges do not cover ciphertext");
    this.chunks.delete(key);
    return result;
  }
}
