import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAppStore } from "../../../app/store";
import { encodeBase64Url } from "../../../security/base64url";
import { getSodium } from "../../../security/sodium";
import {
  signControlPlaneMessageWithKey,
  verifyControlPlaneMessageWithKey,
  verifyPeerControlPlaneMessage,
} from "../controlPlaneAuth";
import type { InternalOnionControlPlaneMessage } from "../types";

describe("internal onion control-plane authentication", () => {
  let publicKey: Uint8Array;
  let privateKey: Uint8Array;

  beforeAll(async () => {
    const sodium = await getSodium();
    const pair = sodium.crypto_sign_keypair();
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
  });

  afterEach(() => {
    useAppStore.setState({ friends: [] });
  });

  const messages: InternalOnionControlPlaneMessage[] = [
    {
      type: "HOP_HELLO",
      circuitId: "circuit-1",
      hopIndex: 1,
      ts: 100,
      senderPeerId: "origin",
    },
    {
      type: "HOP_ACK",
      circuitId: "circuit-1",
      hopIndex: 1,
      ts: 101,
      relayPeerId: "relay-1",
      ok: true,
    },
    { type: "HOP_PING", circuitId: "circuit-1", hopIndex: 1, ts: 102 },
    { type: "HOP_PONG", circuitId: "circuit-1", hopIndex: 1, ts: 103 },
  ];

  it.each(messages)("signs and verifies $type", async (message) => {
    const signed = await signControlPlaneMessageWithKey(message, privateKey);
    expect(signed.sig).toBeTruthy();
    await expect(verifyControlPlaneMessageWithKey(signed, publicKey)).resolves.toBe(true);
  });

  it("rejects unsigned, tampered, and wrong-key messages", async () => {
    const sodium = await getSodium();
    const otherPair = sodium.crypto_sign_keypair();
    const signed = await signControlPlaneMessageWithKey(messages[1], privateKey);
    const tampered = { ...signed, circuitId: "circuit-tampered" };

    await expect(verifyControlPlaneMessageWithKey(messages[1], publicKey)).resolves.toBe(false);
    await expect(verifyControlPlaneMessageWithKey(tampered, publicKey)).resolves.toBe(false);
    await expect(
      verifyControlPlaneMessageWithKey(signed, otherPair.publicKey)
    ).resolves.toBe(false);
  });

  it("resolves a trusted relay identity by device ID", async () => {
    useAppStore.setState({
      friends: [
        {
          id: "friend-1",
          displayName: "Relay",
          status: "",
          theme: "light",
          kind: "friend",
          primaryDeviceId: "relay-device-1",
          identityPub: encodeBase64Url(publicKey),
        },
      ],
    });
    const signed = await signControlPlaneMessageWithKey(messages[1], privateKey);

    await expect(
      verifyPeerControlPlaneMessage(signed, "relay-device-1")
    ).resolves.toBe(true);
    await expect(verifyPeerControlPlaneMessage(signed, "unknown-device")).resolves.toBe(false);
  });
});
