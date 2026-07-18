import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOnionController, type OnionControllerHandle } from "../onionController";
import { TorManager } from "../torManager";
import {
  enrichFriendControlFrameWithProtocol,
  signFriendControlFrame,
  verifyFriendControlFrameProtocol,
  verifyFriendControlFrameSignature,
  type FriendControlFrame,
  type UnsignedFriendControlFrame,
} from "../../friends/friendControlFrame";
import { decodeFriendCodeV1, encodeFriendCodeV1, type FriendCodeV1 } from "../../security/friendCode";
import { encodeBase64Url } from "../../security/base64url";
import { getSodium } from "../../security/sodium";

const LIVE_TOR_ENABLED = process.env.NKC_LIVE_TOR_E2E === "1";
const DEVICE_A = randomUUID();
const DEVICE_B = randomUUID();

type InboxResponse = {
  ok: boolean;
  items: Array<{ id: string; from: string; envelope: string }>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (url: string, payload: unknown, authToken?: string) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { "X-NKC-Controller-Token": authToken } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    forwarded?: boolean;
    via?: string;
    error?: string;
  };
  return { status: response.status, body };
};

const sendOverTor = async (
  sender: OnionControllerHandle,
  recipientOnion: string,
  fromDeviceId: string,
  toDeviceId: string,
  envelope: string
) => {
  let lastResult: Awaited<ReturnType<typeof postJson>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await postJson(
      `${sender.baseUrl}/onion/send`,
      {
        toDeviceId,
        fromDeviceId,
        toOnion: recipientOnion,
        envelope,
        route: { mode: "manual", torOnion: recipientOnion },
      },
      sender.authToken
    );
    if (
      lastResult.status === 200 &&
      lastResult.body.ok === true &&
      lastResult.body.forwarded === true &&
      lastResult.body.via === "tor"
    ) {
      return lastResult;
    }
    if (attempt < 3) await wait(5_000);
  }
  throw new Error(`Tor forwarding failed: ${JSON.stringify(lastResult)}`);
};

const readInbox = async (controller: OnionControllerHandle, deviceId: string) => {
  const response = await fetch(
    `${controller.baseUrl}/onion/inbox?deviceId=${encodeURIComponent(deviceId)}`,
    { headers: { "X-NKC-Controller-Token": controller.authToken } }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as InboxResponse;
};

const requireFriendCode = (code: string) => {
  const decoded = decodeFriendCodeV1(code);
  if ("error" in decoded) throw new Error(decoded.error);
  if (!decoded.deviceId || !decoded.onionAddr) {
    throw new Error("Friend code is missing Tor routing metadata");
  }
  return decoded as FriendCodeV1 & { deviceId: string; onionAddr: string };
};

describe.runIf(LIVE_TOR_ENABLED)("live Tor bidirectional transfer", () => {
  let rootA: string;
  let rootB: string;
  let torA: TorManager;
  let torB: TorManager;
  let controllerA: OnionControllerHandle;
  let controllerB: OnionControllerHandle;
  let onionA: string;
  let onionB: string;
  let friendCodeA: string;
  let friendCodeB: string;
  let identityPrivA: Uint8Array;
  let identityPrivB: Uint8Array;
  let dhPrivA: Uint8Array;
  let dhPrivB: Uint8Array;

  beforeAll(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-live-tor-a-"));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-live-tor-b-"));
    torA = new TorManager({ appDataDir: rootA });
    torB = new TorManager({ appDataDir: rootB });
    controllerA = await startOnionController({ port: 0, getTorStatus: () => torA.getStatus() });
    controllerB = await startOnionController({ port: 0, getTorStatus: () => torB.getStatus() });

    // Start sequentially so each manager observes the SOCKS port held by the previous instance.
    const serviceA = await torA.ensureHiddenService({ localPort: controllerA.port, virtPort: 80 });
    const serviceB = await torB.ensureHiddenService({ localPort: controllerB.port, virtPort: 80 });
    onionA = serviceA.onionHost;
    onionB = serviceB.onionHost;

    const statusA = torA.getStatus();
    const statusB = torB.getStatus();
    if (statusA.state !== "running" || statusB.state !== "running") {
      throw new Error(`Tor did not start: ${JSON.stringify({ statusA, statusB })}`);
    }
    await controllerA.setTorSocksProxy(statusA.socksProxyUrl);
    await controllerB.setTorSocksProxy(statusB.socksProxyUrl);
    controllerA.setTorOnionHost(onionA);
    controllerB.setTorOnionHost(onionB);

    const sodium = await getSodium();
    const identityA = sodium.crypto_sign_keypair();
    const identityB = sodium.crypto_sign_keypair();
    const dhA = sodium.crypto_kx_keypair();
    const dhB = sodium.crypto_kx_keypair();
    identityPrivA = identityA.privateKey;
    identityPrivB = identityB.privateKey;
    dhPrivA = dhA.privateKey;
    dhPrivB = dhB.privateKey;
    friendCodeA = encodeFriendCodeV1({
      v: 1,
      identityPub: encodeBase64Url(identityA.publicKey),
      dhPub: encodeBase64Url(dhA.publicKey),
      deviceId: DEVICE_A,
      onionAddr: onionA,
    });
    friendCodeB = encodeFriendCodeV1({
      v: 1,
      identityPub: encodeBase64Url(identityB.publicKey),
      dhPub: encodeBase64Url(dhB.publicKey),
      deviceId: DEVICE_B,
      onionAddr: onionB,
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([
      controllerA?.close(),
      controllerB?.close(),
      torA?.stop(),
      torB?.stop(),
    ]);
    await Promise.allSettled([
      rootA ? fs.rm(rootA, { recursive: true, force: true }) : Promise.resolve(),
      rootB ? fs.rm(rootB, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }, 30_000);

  it(
    "uses friend codes to establish trust and exchange a file and chat through real onion services",
    async () => {
      expect(onionA).toMatch(/^[a-z2-7]{56}\.onion$/);
      expect(onionB).toMatch(/^[a-z2-7]{56}\.onion$/);
      expect(friendCodeA).toMatch(/^NKC1-/);
      expect(friendCodeB).toMatch(/^NKC1-/);

      const alice = requireFriendCode(friendCodeA);
      const bob = requireFriendCode(friendCodeB);
      expect(alice).toMatchObject({ deviceId: DEVICE_A, onionAddr: onionA });
      expect(bob).toMatchObject({ deviceId: DEVICE_B, onionAddr: onionB });

      const unsignedRequest: UnsignedFriendControlFrame = {
        type: "friend_req",
        traceId: randomUUID(),
        from: {
          identityPub: alice.identityPub,
          dhPub: alice.dhPub,
          deviceId: alice.deviceId,
          friendCode: friendCodeA,
        },
        profile: { displayName: "Alice", status: "Tor live friend request" },
        ts: Date.now(),
      };
      const enrichedRequest = await enrichFriendControlFrameWithProtocol(
        unsignedRequest,
        identityPrivA,
        {
          localFriendCode: friendCodeA,
          localDhPriv: dhPrivA,
          remoteFriendCode: friendCodeB,
          remoteIdentityPub: bob.identityPub,
          remoteDhPub: bob.dhPub,
          remoteDeviceId: bob.deviceId,
          remoteOnionAddr: bob.onionAddr,
        }
      );
      const friendRequest: FriendControlFrame = {
        ...enrichedRequest,
        sig: await signFriendControlFrame(enrichedRequest, identityPrivA),
      } as FriendControlFrame;
      await sendOverTor(
        controllerA,
        bob.onionAddr,
        alice.deviceId,
        bob.deviceId,
        JSON.stringify(friendRequest)
      );
      const requestInbox = await readInbox(controllerB, bob.deviceId);
      const receivedRequest = JSON.parse(
        requestInbox.items.at(-1)?.envelope ?? "null"
      ) as FriendControlFrame;
      expect(receivedRequest).toMatchObject({ type: "friend_req", profile: { displayName: "Alice" } });
      expect(await verifyFriendControlFrameSignature(receivedRequest)).toBe(true);
      expect(await verifyFriendControlFrameProtocol(receivedRequest, {
        localFriendCode: friendCodeB,
        localDhPriv: dhPrivB,
      }))
        .toMatchObject({ ok: true, verified: true });

      const unsignedAccept: UnsignedFriendControlFrame = {
        type: "friend_accept",
        traceId: randomUUID(),
        from: {
          identityPub: bob.identityPub,
          dhPub: bob.dhPub,
          deviceId: bob.deviceId,
          friendCode: friendCodeB,
        },
        profile: { displayName: "Bob", status: "Tor live friend accepted" },
        ts: Date.now(),
      };
      const enrichedAccept = await enrichFriendControlFrameWithProtocol(
        unsignedAccept,
        identityPrivB,
        {
          localFriendCode: friendCodeB,
          localDhPriv: dhPrivB,
          remoteFriendCode: friendCodeA,
          remoteIdentityPub: alice.identityPub,
          remoteDhPub: alice.dhPub,
          remoteDeviceId: alice.deviceId,
          remoteOnionAddr: alice.onionAddr,
        }
      );
      const friendAccept: FriendControlFrame = {
        ...enrichedAccept,
        sig: await signFriendControlFrame(enrichedAccept, identityPrivB),
      } as FriendControlFrame;
      await sendOverTor(
        controllerB,
        alice.onionAddr,
        bob.deviceId,
        alice.deviceId,
        JSON.stringify(friendAccept)
      );
      const acceptInbox = await readInbox(controllerA, alice.deviceId);
      const receivedAccept = JSON.parse(
        acceptInbox.items.at(-1)?.envelope ?? "null"
      ) as FriendControlFrame;
      expect(receivedAccept).toMatchObject({ type: "friend_accept", profile: { displayName: "Bob" } });
      expect(await verifyFriendControlFrameSignature(receivedAccept)).toBe(true);
      expect(await verifyFriendControlFrameProtocol(receivedAccept, {
        localFriendCode: friendCodeA,
        localDhPriv: dhPrivA,
      }))
        .toMatchObject({ ok: true, verified: true });

      const fileBytes = Buffer.from(
        Array.from({ length: 32 * 1024 }, (_, index) => (index * 31 + 17) % 256)
      );
      const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
      const fileEnvelope = JSON.stringify({
        type: "file",
        name: "tor-live-roundtrip.bin",
        mime: "application/octet-stream",
        bytesBase64: fileBytes.toString("base64"),
        sha256: fileSha256,
      });
      const prewarmAtoB = await controllerA.prewarmTorRoute(bob.onionAddr);
      console.info("Tor prewarm A->B", prewarmAtoB);
      const fileStartedAt = Date.now();
      await sendOverTor(
        controllerA,
        bob.onionAddr,
        alice.deviceId,
        bob.deviceId,
        fileEnvelope
      );
      const fileTransferMs = Date.now() - fileStartedAt;

      const inboxB = await readInbox(controllerB, bob.deviceId);
      const receivedFile = JSON.parse(inboxB.items.at(-1)?.envelope ?? "null") as {
        type?: string;
        bytesBase64?: string;
        sha256?: string;
      } | null;
      expect(receivedFile?.type).toBe("file");
      expect(receivedFile?.sha256).toBe(fileSha256);
      expect(
        createHash("sha256")
          .update(Buffer.from(receivedFile?.bytesBase64 ?? "", "base64"))
          .digest("hex")
      ).toBe(fileSha256);

      const chatEnvelope = JSON.stringify({
        type: "chat",
        text: `Tor live reply ${Date.now()}`,
      });
      const prewarmBtoA = await controllerB.prewarmTorRoute(alice.onionAddr);
      console.info("Tor prewarm B->A", prewarmBtoA);
      const chatStartedAt = Date.now();
      await sendOverTor(
        controllerB,
        alice.onionAddr,
        bob.deviceId,
        alice.deviceId,
        chatEnvelope
      );
      const chatTransferMs = Date.now() - chatStartedAt;

      const inboxA = await readInbox(controllerA, alice.deviceId);
      expect(inboxA.items.at(-1)).toMatchObject({ from: bob.deviceId, envelope: chatEnvelope });

      console.info(
        JSON.stringify({
          torConnected: true,
          friendRequestVerified: true,
          friendAcceptVerified: true,
          fileAtoB: true,
          fileBytes: fileBytes.length,
          fileSha256,
          prewarmAtoBMs: prewarmAtoB.elapsedMs,
          fileTransferMs,
          chatBtoA: true,
          prewarmBtoAMs: prewarmBtoA.elapsedMs,
          chatTransferMs,
          onionA,
          onionB,
        })
      );
    },
    300_000
  );
});
