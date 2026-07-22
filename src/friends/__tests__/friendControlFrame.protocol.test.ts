import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";
import { encodeFriendCodeV1 } from "../../security/friendCode";
import {
  enrichFriendControlFrameWithProtocol,
  isFriendControlFrameFresh,
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
  },
  profile: {
    displayName: "Alice",
    status: "hello",
  },
  ts: 1_700_000_000_000,
});

describe("friend control protocol", () => {
  it("rejects expired and far-future control timestamps", () => {
    const now = 1_800_000_000_000;
    const frame = buildUnsignedFrame("identity", "dh") as Parameters<
      typeof isFriendControlFrameFresh
    >[0];
    expect(isFriendControlFrameFresh({ ...frame, ts: now }, now)).toBe(true);
    expect(isFriendControlFrameFresh({ ...frame, ts: now - 8 * 24 * 60 * 60 * 1000 }, now)).toBe(
      false
    );
    expect(isFriendControlFrameFresh({ ...frame, ts: now + 6 * 60 * 1000 }, now)).toBe(false);
  });

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

  it("rejects a friend code whose identity does not match the signed frame", async () => {
    const sodium = await getSodium();
    const senderIdentity = sodium.crypto_sign_keypair();
    const otherIdentity = sodium.crypto_sign_keypair();
    const dhKeyPair = sodium.crypto_kx_keypair();
    const frame = buildUnsignedFrame(
      encodeBase64Url(senderIdentity.publicKey),
      encodeBase64Url(dhKeyPair.publicKey)
    );
    frame.from.friendCode = encodeFriendCodeV1({
      v: 1,
      identityPub: encodeBase64Url(otherIdentity.publicKey),
      dhPub: encodeBase64Url(dhKeyPair.publicKey),
    });
    const check = await verifyFriendControlFrameProtocol(frame);
    expect(check).toMatchObject({ ok: false, reason: "friend-code-identity-mismatch" });
  });
});
