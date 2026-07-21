import { describe, expect, it } from "vitest";
import { deriveConversationKey, deriveConversationKeyPair } from "../box";
import { getSodium } from "../../security/sodium";

describe("deriveConversationKeyPair", () => {
  it("matches the existing independent derivations", async () => {
    const sodium = await getSodium();
    const local = sodium.crypto_box_keypair();
    const remote = sodium.crypto_box_keypair();
    const psk = sodium.randombytes_buf(32);
    const legacyContext = new TextEncoder().encode("direct:friend-1");
    const ratchetContext = new TextEncoder().encode("conv:conversation-1");

    const expectedConversationKey = await deriveConversationKey(
      local.privateKey,
      remote.publicKey,
      psk,
      legacyContext
    );
    const expectedRatchetBaseKey = await deriveConversationKey(
      local.privateKey,
      remote.publicKey,
      psk,
      ratchetContext
    );
    const actual = await deriveConversationKeyPair(
      local.privateKey,
      remote.publicKey,
      psk,
      legacyContext,
      ratchetContext
    );

    expect(actual.conversationKey).toEqual(expectedConversationKey);
    expect(actual.ratchetBaseKey).toEqual(expectedRatchetBaseKey);
  });
});
