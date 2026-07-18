import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOnionController, type OnionControllerHandle } from "../onionController";
import { TorManager } from "../torManager";

const LIVE_TOR_ENABLED = process.env.NKC_LIVE_TOR_E2E === "1";
const DEVICE_A = "live-tor-device-a";
const DEVICE_B = "live-tor-device-b";

type InboxResponse = {
  ok: boolean;
  items: Array<{ id: string; from: string; envelope: string }>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (url: string, payload: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    lastResult = await postJson(`${sender.baseUrl}/onion/send`, {
      toDeviceId,
      fromDeviceId,
      toOnion: recipientOnion,
      envelope,
      route: { mode: "manual", torOnion: recipientOnion },
    });
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
    `${controller.baseUrl}/onion/inbox?deviceId=${encodeURIComponent(deviceId)}`
  );
  expect(response.status).toBe(200);
  return (await response.json()) as InboxResponse;
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
    "exchanges a file A to B and a chat message B to A through real onion services",
    async () => {
      expect(onionA).toMatch(/^[a-z2-7]{56}\.onion$/);
      expect(onionB).toMatch(/^[a-z2-7]{56}\.onion$/);

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
      const prewarmAtoB = await controllerA.prewarmTorRoute(onionB);
      console.info("Tor prewarm A->B", prewarmAtoB);
      const fileStartedAt = Date.now();
      await sendOverTor(controllerA, onionB, DEVICE_A, DEVICE_B, fileEnvelope);
      const fileTransferMs = Date.now() - fileStartedAt;

      const inboxB = await readInbox(controllerB, DEVICE_B);
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
      const prewarmBtoA = await controllerB.prewarmTorRoute(onionA);
      console.info("Tor prewarm B->A", prewarmBtoA);
      const chatStartedAt = Date.now();
      await sendOverTor(controllerB, onionA, DEVICE_B, DEVICE_A, chatEnvelope);
      const chatTransferMs = Date.now() - chatStartedAt;

      const inboxA = await readInbox(controllerA, DEVICE_A);
      expect(inboxA.items.at(-1)).toMatchObject({ from: DEVICE_B, envelope: chatEnvelope });

      console.info(
        JSON.stringify({
          torConnected: true,
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
