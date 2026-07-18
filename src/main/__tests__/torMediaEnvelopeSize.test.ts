import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptEnvelope, encryptEnvelope, type EnvelopeHeader } from "../../crypto/box";
import { INLINE_MEDIA_CHUNK_SIZE } from "../../net/mediaTransferLimits";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";

const ONION_CONTROLLER_MAX_BODY_BYTES = 256 * 1024;

describe("Tor media envelope sizing", () => {
  it("keeps an encrypted media chunk inside the controller request limit", async () => {
    const sodium = await getSodium();
    const identity = sodium.crypto_sign_keypair();
    const key = sodium.randombytes_buf(32);
    const bytes = sodium.randombytes_buf(INLINE_MEDIA_CHUNK_SIZE);
    const header: EnvelopeHeader = {
      v: 1,
      convId: randomUUID(),
      eventId: randomUUID(),
      authorDeviceId: randomUUID(),
      ts: Date.now(),
      lamport: 1,
    };
    const envelope = await encryptEnvelope(
      key,
      header,
      {
        type: "media",
        phase: "chunk",
        ownerId: randomUUID(),
        idx: 0,
        total: 4_000,
        chunkSize: INLINE_MEDIA_CHUNK_SIZE,
        mime: "application/octet-stream",
        name: "large-transfer.bin",
        size: 500 * 1024 * 1024,
        b64: encodeBase64Url(bytes),
        clientBatchId: randomUUID(),
      },
      identity.privateKey
    );
    const envelopeJson = JSON.stringify(envelope);
    const requestBody = JSON.stringify({
      toDeviceId: randomUUID(),
      fromDeviceId: randomUUID(),
      toOnion: `${"a".repeat(56)}.onion`,
      envelope: envelopeJson,
      route: { mode: "manual", torOnion: `${"a".repeat(56)}.onion` },
    });

    expect(Buffer.byteLength(envelopeJson)).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(requestBody)).toBeLessThanOrEqual(ONION_CONTROLLER_MAX_BODY_BYTES);

    const decrypted = await decryptEnvelope<{ b64: string }>(
      key,
      envelope,
      identity.publicKey
    );
    expect(decodeBase64Url(decrypted.b64)).toEqual(bytes);
  });
});
