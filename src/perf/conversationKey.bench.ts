import { beforeAll, bench, describe } from "vitest";
import { deriveConversationKey, deriveConversationKeyPair } from "../crypto/box";
import { getSodium } from "../security/sodium";

let localPrivateKey: Uint8Array;
let remotePublicKey: Uint8Array;
let psk: Uint8Array;
const encoder = new TextEncoder();
const legacyContext = encoder.encode("direct:benchmark-friend");
const ratchetContext = encoder.encode("conv:benchmark-conversation");

beforeAll(async () => {
  const sodium = await getSodium();
  localPrivateKey = sodium.crypto_box_keypair().privateKey;
  remotePublicKey = sodium.crypto_box_keypair().publicKey;
  psk = sodium.randombytes_buf(32);
});

describe("conversation key derivation", () => {
  bench("two independent shared-secret calculations", async () => {
    await deriveConversationKey(localPrivateKey, remotePublicKey, psk, legacyContext);
    await deriveConversationKey(localPrivateKey, remotePublicKey, psk, ratchetContext);
  });

  bench("one shared-secret calculation for both keys", async () => {
    await deriveConversationKeyPair(
      localPrivateKey,
      remotePublicKey,
      psk,
      legacyContext,
      ratchetContext
    );
  });
});
