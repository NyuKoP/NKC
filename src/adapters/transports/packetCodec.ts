export type PayloadB64 = { b64: string };

type PacketRoute = {
  toDeviceId?: string;
  to?: string;
  torOnion?: string;
  toOnion?: string;
  inboxWriteToken?: string;
  signal?: AbortSignal;
  mode?: import("../../main/routePolicy").RouteMode;
  routeMode?: import("../../main/routePolicy").RouteMode;
  routePolicy?: import("../../main/routePolicy").RouteMode;
};

export type TransportPacket = {
  id: string;
  payload: Uint8Array | string | PayloadB64;
  toDeviceId?: string;
  to?: string;
  torOnion?: string;
  toOnion?: string;
  signal?: AbortSignal;
  route?: PacketRoute;
  meta?: PacketRoute;
  replyRoute?: {
    toDeviceId: string;
    torOnion?: string;
    inboxWriteToken?: string;
    sentAt: number;
  };
  deliveryAck?: {
    messageId: string;
    sentAt: number;
  };
};


import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { canonicalBytes } from "../../crypto/canonicalJson";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../../net/mediaTransferLimits";

const MAGIC = new Uint8Array([0x4e, 0x4b, 0x43, 0x50, 0x01]); // NKCP + version 1

const HEADER_LENGTH_BYTES = 4;

const MAX_HEADER_BYTES = 64 * 1024;

const MAX_BINARY_PACKET_BYTES = ONION_TRANSFER_MAX_BODY_BYTES;

const PACKET_METADATA_KEYS = new Set(["id", "toDeviceId", "to", "torOnion", "toOnion", "route", "meta", "replyRoute", "deliveryAck"]);

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Scheduling only: every selected control still passes the ordinary authenticated dispatcher. */
export const prioritizeSessionControls = <T extends { envelope: string | Uint8Array }>(items: T[]): T[] => {
  const controls: T[] = [], remaining: T[] = [];

  for (const item of items) {
    let urgent = false;

    try {
      const packet = decodeInboxTransportPacket(item.envelope);
      const payload = packet?.payload;

      const text = typeof payload === "string" ? payload : payload instanceof Uint8Array ? textDecoder.decode(payload)
        : payload ? textDecoder.decode(decodeBase64Url(payload.b64)) : "";

      urgent = ["HELLO", "ACK", "SESSION_READY"].includes(JSON.parse(text).type);
    } catch { /* Malformed items retain their ordinary safe-failure path. */ }

    (urgent ? controls : remaining).push(item);
  }

  return controls.concat(remaining);
};

const hasMagic = (bytes: Uint8Array) =>
  bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);

const toBytes = (value: ArrayBuffer | Uint8Array) =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const metadataV2 = (input: Record<string, unknown>, outgoing: boolean): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  const strings = (object: Record<string, unknown>, fields: string[]) => {
    for (const field of fields) {
      const value = object[field];

      if (value !== undefined && (typeof value !== "string" || value.length > 1024)) throw new Error("INVALID_BINARY_PACKET_HEADER");
    }
  };

  for (const [key, value] of Object.entries(input)) {
    if (key === "signal" && outgoing || value === undefined) continue;

    if (!PACKET_METADATA_KEYS.has(key)) throw new Error("INVALID_BINARY_PACKET_HEADER");
    result[key] = value;
  }

  if (typeof result.id !== "string" || !result.id || result.id.length > 128) throw new Error("INVALID_BINARY_PACKET_HEADER");
  strings(result, ["toDeviceId", "to", "torOnion", "toOnion"]);

  for (const field of ["route", "meta", "replyRoute", "deliveryAck"]) {
    if (result[field] === undefined) continue;
    const value = result[field];

    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_BINARY_PACKET_HEADER");
    const nested: Record<string, unknown> = { ...value };

    if (outgoing) delete nested.signal;

    const keys = field === "deliveryAck" ? ["messageId", "sentAt"] : field === "replyRoute"
      ? ["toDeviceId", "torOnion", "inboxWriteToken", "sentAt"]
      : ["toDeviceId", "to", "torOnion", "toOnion", "inboxWriteToken", "mode", "routeMode", "routePolicy"];

    if (Object.keys(nested).some(key => !keys.includes(key))) throw new Error("INVALID_BINARY_PACKET_HEADER");
    strings(nested, keys.filter(key => key !== "sentAt"));

    for (const key of ["mode", "routeMode", "routePolicy"]) {
      const mode = nested[key];

      if (mode !== undefined && mode !== "auto" && mode !== "preferTor" && mode !== "manual") throw new Error("INVALID_BINARY_PACKET_HEADER");
    }

    if (field === "replyRoute" || field === "deliveryAck") {
      const id = nested[field === "replyRoute" ? "toDeviceId" : "messageId"];

      if (typeof id !== "string" || !id || !Number.isSafeInteger(nested.sentAt) || (nested.sentAt as number) < 0) {
        throw new Error("INVALID_BINARY_PACKET_HEADER");
      }
    }

    result[field] = nested;
  }

  return result;
};

export const encodeBinaryTransportPacket = (packet: TransportPacket, version: 1 | 2 = 1): Uint8Array | null => {
  if (version !== 1 && version !== 2) throw new Error("UNSUPPORTED_BINARY_PACKET_VERSION");

  if (!(packet.payload instanceof Uint8Array)) return null;

  const { payload, ...metadata } = packet;
  const header = version === 2 ? canonicalBytes(metadataV2(metadata, true)) : textEncoder.encode(JSON.stringify(metadata));
  const prefixLength = MAGIC.length + HEADER_LENGTH_BYTES + (version === 2 ? 4 : 0);

  if (header.length > MAX_HEADER_BYTES) {
    throw new Error("Transport packet header is too large");
  }

  const total = prefixLength + header.length + payload.byteLength;

  if (version === 2 && (total > MAX_BINARY_PACKET_BYTES || typeof packet.id !== "string" || !packet.id || packet.id.length > 128)) {
    throw new Error("INVALID_BINARY_PACKET_LENGTH");
  }

  const result = new Uint8Array(total);

  result.set(MAGIC, 0);
  result[4] = version;
  new DataView(result.buffer).setUint32(MAGIC.length, header.length, false);

  if (version === 2) new DataView(result.buffer).setUint32(9, payload.length, false);
  result.set(header, prefixLength);
  result.set(payload, prefixLength + header.length);

  return result;
};

/** Negotiation is the caller's responsibility. Invalid v2 is never reinterpreted as a legacy packet. */
export const decodeBinaryTransportPacketV2 = (value: ArrayBuffer | Uint8Array): TransportPacket => {
  const bytes = toBytes(value);

  if (bytes.length < 13 || bytes.length > MAX_BINARY_PACKET_BYTES || bytes[4] !== 2 ||
    !MAGIC.subarray(0, 4).every((byte, index) => bytes[index] === byte)) throw new Error("INVALID_BINARY_PACKET_FORMAT");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(5, false), payloadLength = view.getUint32(9, false);

  if (!headerLength || headerLength > MAX_HEADER_BYTES || 13 + headerLength + payloadLength !== bytes.length) {
    throw new Error("INVALID_BINARY_PACKET_LENGTH");
  }

  const header = bytes.subarray(13, 13 + headerLength);
  const metadata = JSON.parse(textDecoder.decode(header)) as Record<string, unknown>;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof metadata.id !== "string" ||
    !metadata.id || metadata.id.length > 128 || Object.hasOwn(metadata, "payload")) throw new Error("INVALID_BINARY_PACKET_HEADER");
  const validated = metadataV2(metadata, false);
  const canonical = canonicalBytes(validated);

  if (canonical.length !== header.length || !canonical.every((byte, index) => byte === header[index])) {
    throw new Error("NON_CANONICAL_BINARY_PACKET_HEADER");
  }

  return { ...validated, id: metadata.id, payload: bytes.slice(13 + headerLength) };
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
    };
  } catch {
    return null;
  }
};

export const isBinaryTransportPacket = (value: ArrayBuffer | Uint8Array) =>
  hasMagic(toBytes(value));

/** Existing Controller inbox wire format, shared by ordinary polling and durable queue handoff. */
export const encodeInboxTransportPacket = (packet: TransportPacket) =>
  encodeBase64Url(encodeBinaryTransportPacket(packet) ?? textEncoder.encode(JSON.stringify(packet)));

export const decodeInboxTransportPacket = (envelope: string | Uint8Array): TransportPacket | null => {
  if (envelope instanceof Uint8Array) {
    try { return decodeBinaryTransportPacketV2(envelope); } catch { return null; }
  }

  try {
    const bytes = decodeBase64Url(envelope);
    const binary = decodeBinaryTransportPacket(bytes);

    if (binary) return binary;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as TransportPacket;

    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
};
