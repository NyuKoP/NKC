import type { EventRecord, OutboxRecord } from "../db/schema";
import { decodeBinaryEnvelopeFrame } from "../crypto/binaryEnvelope";
import { decodeBinaryTransportPacketV2, encodeBinaryTransportPacket } from "../adapters/transports/packetCodec";
import { isEnvelopeLike } from "../crypto/box";

/** Parse representation, not authentication. Callers still verify signature/session/hash before effects. */
export const readEventEnvelope = (event: EventRecord | { eventId: string; envelopeJson: string; envelopeFormat?: never }) => {
  if (event.envelopeFormat === "nkce-v1") {
    if ("envelopeJson" in event) throw new Error("BINARY_RECORD_FORMAT_MISMATCH");
    const envelope = decodeBinaryEnvelopeFrame(event.envelopeBytes);

    if (envelope.header.eventId !== event.eventId || envelope.header.convId !== event.convId ||
        envelope.header.authorDeviceId !== event.authorDeviceId || envelope.header.lamport !== event.lamport ||
        envelope.header.ts !== event.ts) throw new Error("BINARY_EVENT_OUTBOX_BINDING_MISMATCH");

    return envelope;
  }

  const envelope: unknown = JSON.parse(legacyEventJson(event));

  if (!isEnvelopeLike(envelope)) throw new Error("INVALID_STORED_ENVELOPE");

  return envelope;
};

export const samePayloadBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

export const sameOutboxPayload = (a: OutboxRecord, b: OutboxRecord) => {
  if (a.payloadFormat !== b.payloadFormat) return false;

  if (a.payloadFormat === "nkcp-v2" && b.payloadFormat === "nkcp-v2") {
    return a.payloadBytes instanceof Uint8Array && b.payloadBytes instanceof Uint8Array &&
      a.nativeRetryId === b.nativeRetryId && samePayloadBytes(a.payloadBytes, b.payloadBytes);
  }

  return a.payloadFormat === undefined && b.payloadFormat === undefined &&
    typeof a.ciphertext === "string" && a.ciphertext === b.ciphertext;
};

// Legacy protocol readers must fail explicitly until their raw dispatch is implemented.
export const legacyEventJson = (record: { envelopeFormat?: string; envelopeJson?: string }) => {
  if (record.envelopeFormat !== undefined || typeof record.envelopeJson !== "string" || "envelopeBytes" in record) {
    throw new Error("BINARY_EVENT_READER_NOT_INTEGRATED");
  }

  return record.envelopeJson;
};

export const legacyOutboxCiphertext = (record: { payloadFormat?: string; ciphertext?: string }) => {
  if (record.payloadFormat !== undefined || typeof record.ciphertext !== "string" || "payloadBytes" in record || "nativeRetryId" in record) {
    throw new Error("BINARY_OUTBOX_TRANSPORT_NOT_INTEGRATED");
  }

  return record.ciphertext;
};

export const computeBinaryRetryId = async (packetBytes: Uint8Array) => {
  const domain = new TextEncoder().encode("NKC|OWNED-BINARY|1\0");
  const material = new Uint8Array(domain.length + packetBytes.length);
  material.set(domain);
  material.set(packetBytes, domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));

  return "owned-binary-v1:" + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
};

export const validateBinaryEventOutbox = (event: EventRecord, outbox: OutboxRecord) => {
  if (event.envelopeFormat !== "nkce-v1" || outbox.payloadFormat !== "nkcp-v2" ||
      !(event.envelopeBytes instanceof Uint8Array) || !(outbox.payloadBytes instanceof Uint8Array) ||
      event.envelopeJson !== undefined || outbox.ciphertext !== undefined || !event.localConvId) throw new Error("BINARY_RECORD_FORMAT_MISMATCH");

  const envelope = decodeBinaryEnvelopeFrame(event.envelopeBytes);
  const packet = decodeBinaryTransportPacketV2(outbox.payloadBytes);
  const expected = encodeBinaryTransportPacket({ id: event.eventId, payload: event.envelopeBytes, replyRoute: packet.replyRoute }, 2);

  if (!expected || !samePayloadBytes(expected, outbox.payloadBytes) || !(packet.payload instanceof Uint8Array) || !samePayloadBytes(packet.payload, event.envelopeBytes) ||
      packet.id !== event.eventId || envelope.header.eventId !== event.eventId || outbox.id !== event.eventId ||
      outbox.convId !== (event.localConvId ?? event.convId) ||
      envelope.header.convId !== event.convId || envelope.header.authorDeviceId !== event.authorDeviceId ||
      envelope.header.ts !== event.ts || envelope.header.lamport !== event.lamport) throw new Error("BINARY_EVENT_OUTBOX_BINDING_MISMATCH");

  return { envelope, packet };
};
