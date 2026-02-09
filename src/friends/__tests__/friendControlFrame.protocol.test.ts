import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";
import {
  enrichFriendControlFrameWithProtocol,
  verifyFriendControlFrameProtocol,
  type UnsignedFriendControlFrame,
} from "../friendControlFrame";

const buildUnsignedFrame = (identityPub: string, dhPub: string): UnsignedFriendControlFrame => ({
  type: "friend_req",
  convId: "conv-1",
  from: {
    identityPub,
    dhPub,
    deviceId: "device-1",
    friendCode: "friend-code",
  },
  profile: {
    displayName: "Alice",
    status: "hello",
  },
  ts: 1_700_000_000_000,
});

describe("friendControlFrame briar protocol", () => {
  it("verifies enriched protocol", async () => {
    const sodium = await getSodium();
    const identityKeyPair = sodium.crypto_sign_keypair();
    const dhKeyPair = sodium.crypto_kx_keypair();
    const frame = buildUnsignedFrame(
      encodeBase64Url(identityKeyPair.publicKey),
      encodeBase64Url(dhKeyPair.publicKey)
    );
    const withProtocol = await enrichFriendControlFrameWithProtocol(
      frame,
      identityKeyPair.privateKey
    );
    const check = await verifyFriendControlFrameProtocol(withProtocol);
    expect(check.ok).toBe(true);
    expect(check.verified).toBe(true);
  });

  it("fails verification when frame content is tampered after protocol generation", async () => {
    const sodium = await getSodium();
    const identityKeyPair = sodium.crypto_sign_keypair();
    const dhKeyPair = sodium.crypto_kx_keypair();
    const frame = buildUnsignedFrame(
      encodeBase64Url(identityKeyPair.publicKey),
      encodeBase64Url(dhKeyPair.publicKey)
    );
    const withProtocol = await enrichFriendControlFrameWithProtocol(
      frame,
      identityKeyPair.privateKey
    );
    const tampered = {
      ...withProtocol,
      from: {
        ...withProtocol.from,
        deviceId: "device-2",
      },
    };
    const check = await verifyFriendControlFrameProtocol(tampered);
    expect(check.ok).toBe(false);
    expect(check.verified).toBe(true);
  });
});

