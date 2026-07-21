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
    expect(res.version).toBe(1);
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

  it("verifies file.chunk payload data integrity and sha256 hash match", async () => {
    const chunkSize = 512 * 1024;
    const res = await client.request<{ index: number; bytes: number; data: string; sha256: string }>(
      "file.chunk",
      { path: tempFilePath, index: 0, chunkSize }
    );

    expect(res.index).toBe(0);
    expect(res.bytes).toBe(chunkSize);

    // Decode RawURLEncoding Base64
    const b64Standard = res.data.replace(/-/g, "+").replace(/_/g, "/");
    const decodedBuffer = Buffer.from(b64Standard, "base64");
    expect(decodedBuffer.byteLength).toBe(chunkSize);

    // Byte-level integrity check against original source buffer
    const expectedChunkBuffer = sampleBuffer.subarray(0, chunkSize);
    expect(decodedBuffer.equals(expectedChunkBuffer)).toBe(true);

    // SHA256 checksum check
    const chunkSha256 = crypto.createHash("sha256").update(decodedBuffer).digest("hex");
    expect(res.sha256).toBe(chunkSha256);
  });
});
