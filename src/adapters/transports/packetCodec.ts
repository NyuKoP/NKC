import type { TransportPacket } from "./types";

const MAGIC = new Uint8Array([0x4e, 0x4b, 0x43, 0x50, 0x01]); // NKCP + version 1
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const hasMagic = (bytes: Uint8Array) =>
  bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);

const toBytes = (value: ArrayBuffer | Uint8Array) =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

export const encodeBinaryTransportPacket = (packet: TransportPacket): Uint8Array | null => {
  if (!(packet.payload instanceof Uint8Array)) return null;

  const { payload, ...metadata } = packet;
  const header = textEncoder.encode(JSON.stringify(metadata));
  if (header.length > MAX_HEADER_BYTES) {
    throw new Error("Transport packet header is too large");
  }

  const result = new Uint8Array(
    MAGIC.length + HEADER_LENGTH_BYTES + header.length + payload.byteLength
  );
  result.set(MAGIC, 0);
  new DataView(result.buffer).setUint32(MAGIC.length, header.length, false);
  result.set(header, MAGIC.length + HEADER_LENGTH_BYTES);
  result.set(payload, MAGIC.length + HEADER_LENGTH_BYTES + header.length);
  return result;
};

export const decodeBinaryTransportPacket = (
  value: ArrayBuffer | Uint8Array
): TransportPacket | null => {
  const bytes = toBytes(value);
  if (!hasMagic(bytes) || bytes.length < MAGIC.length + HEADER_LENGTH_BYTES) return null;

  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + MAGIC.length,
    HEADER_LENGTH_BYTES
  ).getUint32(0, false);
  if (headerLength > MAX_HEADER_BYTES) return null;

  const payloadOffset = MAGIC.length + HEADER_LENGTH_BYTES + headerLength;
  if (payloadOffset > bytes.length) return null;

  try {
    const metadata = JSON.parse(
      textDecoder.decode(bytes.subarray(MAGIC.length + HEADER_LENGTH_BYTES, payloadOffset))
    ) as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || typeof metadata.id !== "string") return null;
    return {
      ...metadata,
      id: metadata.id,
      payload: bytes.slice(payloadOffset),
    } as TransportPacket;
  } catch {
    return null;
  }
};

export const isBinaryTransportPacket = (value: ArrayBuffer | Uint8Array) =>
  hasMagic(toBytes(value));
