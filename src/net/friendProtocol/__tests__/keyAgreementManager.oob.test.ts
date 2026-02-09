import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../../../security/base64url";
import { encodeFriendCodeV1 } from "../../../security/friendCode";
import { getSodium } from "../../../security/sodium";

const state = vi.hoisted(() => ({
  activePeer: "alice" as "alice" | "bob",
  alice: {
    identityPub: new Uint8Array(),
    dhPub: new Uint8Array(),
    dhPriv: new Uint8Array(),
  },
  bob: {
    identityPub: new Uint8Array(),
    dhPub: new Uint8Array(),
    dhPriv: new Uint8Array(),
  },
}));

vi.mock("../../../security/identityKeys", () => ({
  getIdentityPublicKey: vi.fn(async () =>
    state.activePeer === "alice" ? state.alice.identityPub : state.bob.identityPub
  ),
  getDhPublicKey: vi.fn(async () =>
    state.activePeer === "alice" ? state.alice.dhPub : state.bob.dhPub
  ),
  getDhPrivateKey: vi.fn(async () =>
    state.activePeer === "alice" ? state.alice.dhPriv : state.bob.dhPriv
  ),
}));

vi.mock("../../../security/deviceRole", () => ({
  getOrCreateDeviceId: () =>
    state.activePeer === "alice"
      ? "123e4567-e89b-42d3-a456-426614174001"
      : "123e4567-e89b-42d3-a456-426614174002",
}));

import { buildKeyAgreementRecord, verifyKeyAgreementRecord } from "../keyAgreementManager";
import type { BriarContactExchangeRecord, BriarHandshakeRecord, HandshakeFrameInput } from "../types";

const handshake: BriarHandshakeRecord = {
  v: 1,
  transcriptHash: "transcript",
  proofSig: "proof",
};

const contactExchange: BriarContactExchangeRecord = {
  v: 1,
  profileHash: "profile",
  keyCommitment: "commitment",
  profileSig: "sig",
};

const toFriendCode = (identityPub: Uint8Array, dhPub: Uint8Array, deviceId: string) =>
  encodeFriendCodeV1({
    v: 1,
    identityPub: encodeBase64Url(identityPub),
    dhPub: encodeBase64Url(dhPub),
    deviceId,
  });

const toFrameFromAlice = (friendCode: string): HandshakeFrameInput => ({
  type: "friend_req",
  convId: "conv-1",
  ts: 1_700_000_000_000,
  from: {
    identityPub: encodeBase64Url(state.alice.identityPub),
    dhPub: encodeBase64Url(state.alice.dhPub),
    deviceId: "123e4567-e89b-42d3-a456-426614174001",
    friendCode,
  },
  profile: {
    displayName: "Alice",
  },
});

describe("keyAgreementManager OOB friend code", () => {
  beforeEach(async () => {
    const sodium = await getSodium();
    const aliceIdentity = sodium.crypto_sign_keypair();
    const aliceDh = sodium.crypto_kx_keypair();
    const bobIdentity = sodium.crypto_sign_keypair();
    const bobDh = sodium.crypto_kx_keypair();
    state.alice = {
      identityPub: aliceIdentity.publicKey,
      dhPub: aliceDh.publicKey,
      dhPriv: aliceDh.privateKey,
    };
    state.bob = {
      identityPub: bobIdentity.publicKey,
      dhPub: bobDh.publicKey,
      dhPriv: bobDh.privateKey,
    };
    state.activePeer = "alice";
  });

  it("builds sender record from friend code OOB and verifies on receiver side", async () => {
    const aliceCode = toFriendCode(
      state.alice.identityPub,
      state.alice.dhPub,
      "123e4567-e89b-42d3-a456-426614174001"
    );
    const bobCode = toFriendCode(
      state.bob.identityPub,
      state.bob.dhPub,
      "123e4567-e89b-42d3-a456-426614174002"
    );

    const record = await buildKeyAgreementRecord(handshake, contactExchange, {
      localFriendCode: aliceCode,
      remoteFriendCode: bobCode,
    });
    expect(record.method).toBe("friend_code_oob_v1");
    expect(record.payload).toBeTruthy();
    expect(record.commitment).toBeTruthy();
    expect(record.role === "alice" || record.role === "bob").toBe(true);

    const frame = toFrameFromAlice(aliceCode);
    state.activePeer = "bob";
    const check = await verifyKeyAgreementRecord(
      frame,
      handshake,
      contactExchange,
      record,
      { localFriendCode: bobCode }
    );
    expect(check.ok).toBe(true);
  });

  it("fails when role is tampered", async () => {
    const aliceCode = toFriendCode(
      state.alice.identityPub,
      state.alice.dhPub,
      "123e4567-e89b-42d3-a456-426614174001"
    );
    const bobCode = toFriendCode(
      state.bob.identityPub,
      state.bob.dhPub,
      "123e4567-e89b-42d3-a456-426614174002"
    );
    const record = await buildKeyAgreementRecord(handshake, contactExchange, {
      localFriendCode: aliceCode,
      remoteFriendCode: bobCode,
    });
    expect(record.role).toBeTruthy();

    const frame = toFrameFromAlice(aliceCode);
    state.activePeer = "bob";
    const tampered = {
      ...record,
      role: record.role === "alice" ? "bob" : "alice",
    } as typeof record;
    const check = await verifyKeyAgreementRecord(
      frame,
      handshake,
      contactExchange,
      tampered,
      { localFriendCode: bobCode }
    );
    expect(check.ok).toBe(false);
  });
});
