import { describe, expect, it } from "vitest";
import { computeEnvelopeHash, type Envelope } from "../box";
import { getSodium } from "../../security/sodium";

describe("computeEnvelopeHash", () => {
  it("is deterministic for the same envelope", async () => {
    const sodium = await getSodium();
    const header = {
      v: 1 as const,
      convId: "c1",
      eventId: "e1",
      authorDeviceId: "d1",
      ts: 123,
      lamport: 1,
    };
    const nonce = sodium.randombytes_buf(24);
    const ciphertext = sodium.randombytes_buf(32);
    const sig = sodium.randombytes_buf(64);
    const envelope: Envelope = {
      header,
      nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
      sig: sodium.to_base64(sig, sodium.base64_variants.ORIGINAL),
    };

    const first = await computeEnvelopeHash(envelope);
    const second = await computeEnvelopeHash(envelope);
    expect(first).toBe(second);
  });
});
