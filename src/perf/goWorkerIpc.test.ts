import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { NativeWorkerClient } from "../main/nativeWorkerClient";

const root = process.cwd();
const executableName = process.platform === "win32" ? "nkc-worker.exe" : "nkc-worker";
const executablePath = path.join(root, "native", "bin", executableName);
const hasWorkerBinary = fs.existsSync(executablePath);

describe.skipIf(!hasWorkerBinary)("Go Worker IPC Functional & Integrity Tests", () => {
  let client: NativeWorkerClient;
  let tempFilePath: string;
  let sampleBuffer: Buffer;
  let expectedSha256: string;

  beforeAll(async () => {
    client = new NativeWorkerClient(executablePath);
    await client.start();

    // Create a 1MiB test file with random bytes.
    tempFilePath = path.join(root, "node_modules", ".cache", "go-ipc-integrity-test.tmp");
    const dir = path.dirname(tempFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    sampleBuffer = crypto.randomBytes(1024 * 1024);
    expectedSha256 = crypto.createHash("sha256").update(sampleBuffer).digest("hex");
    fs.writeFileSync(tempFilePath, sampleBuffer);
  }, 30_000);

  afterAll(async () => {
    await client.stop();
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {
        console.warn("[go-worker-test] Failed to clean up temp file:", err);
      }
    }
  });

  it("verifies health RPC response and features", async () => {
    const res = await client.request<{ version: number; features: string[] }>("health", {});
    expect(res.version).toBe(2);
    expect(res.features).toContain("file");
    expect(res.features).toContain("queue");
  });

  it("verifies file.inspect sha256 and chunk count", async () => {
    const chunkSize = 512 * 1024;
    const res = await client.request<{ size: number; chunkSize: number; total: number; sha256: string }>(
      "file.inspect",
      { path: tempFilePath, chunkSize }
    );
    expect(res.size).toBe(1024 * 1024);
    expect(res.chunkSize).toBe(chunkSize);
    expect(res.total).toBe(2);
    expect(res.sha256).toBe(expectedSha256);
  });

  it("verifies binary file.chunk payload data integrity and sha256 hash match", async () => {
    const chunkSize = 512 * 1024;
    const response = await client.requestBinary<{ index: number; bytes: number }>(
      "file.chunk.binary",
      { path: tempFilePath, index: 0, chunkSize }
    );
    const res = response.result;

    expect(res.index).toBe(0);
    expect(res.bytes).toBe(chunkSize);

    expect(response.body.byteLength).toBe(chunkSize);

    // Byte-level integrity check against original source buffer
    const expectedChunkBuffer = sampleBuffer.subarray(0, chunkSize);
    expect(response.body.equals(expectedChunkBuffer)).toBe(true);

  });

  it("passes a 1 MiB onion envelope in the binary frame body instead of the JSON header", async () => {
    const payload = {
      toDeviceId: "device-b",
      fromDeviceId: "device-a",
      toOnion: `${"a".repeat(56)}.onion`,
      envelope: "x".repeat(1024 * 1024),
      route: { mode: "manual", torOnion: `${"a".repeat(56)}.onion` },
    };
    const response = await client.requestBinary<{ status: number; body: { error?: string } }>(
      "transport.forward.binary",
      { torProxyUrl: "", queueOnFailure: false },
      Buffer.from(JSON.stringify(payload), "utf8")
    );
    expect(response.result.status).toBe(400);
    expect(response.result.body.error).toBe("forward_failed:no_route");
  });
});
