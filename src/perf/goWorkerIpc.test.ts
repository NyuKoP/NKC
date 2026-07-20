import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { NativeWorkerClient } from "../main/nativeWorkerClient";

describe("Go Worker Stdin/Stdout IPC Benchmark", () => {
  let client: NativeWorkerClient | null = null;
  let tempFilePath: string | null = null;

  beforeAll(async () => {
    const root = process.cwd();
    const executableName = process.platform === "win32" ? "nkc-worker.exe" : "nkc-worker";
    let executablePath = path.join(root, "native", "bin", executableName);

    if (!fs.existsSync(executablePath)) {
      try {
        console.info("[go-ipc-bench] Building Go worker binary...");
        execSync("node scripts/build-go-worker.mjs", { cwd: root, stdio: "inherit" });
      } catch (err) {
        console.warn("[go-ipc-bench] Failed to build Go worker. Tests will skip if binary is missing.", err);
      }
    }

    if (fs.existsSync(executablePath)) {
      client = new NativeWorkerClient(executablePath);
      await client.start();
    }

    // Create a 1MB temp file to benchmark file.chunk IPC reads
    tempFilePath = path.join(root, "node_modules", ".cache", "ipc-test-1mb.tmp");
    const dir = path.dirname(tempFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    fs.writeFileSync(tempFilePath, chunk);
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.stop();
    }
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  });

  it("measures health RPC roundtrip latency (100 iterations)", async () => {
    if (!client) {
      console.warn("[go-ipc-bench] Skipped: Go worker binary not available.");
      return;
    }

    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const res = await client.request<{ version: number }>("health", {});
      expect(res.version).toBe(1);
    }

    const totalMs = performance.now() - start;
    const avgMs = totalMs / iterations;
    console.info(`[go-ipc-bench] Health RPC avg latency: ${avgMs.toFixed(3)} ms per request (${totalMs.toFixed(2)} ms total for ${iterations} requests)`);
    expect(avgMs).toBeLessThan(50); // Should be very fast (typically < 1-2ms)
  });

  it("measures 512KB chunk file.chunk RPC IPC throughput", async () => {
    if (!client || !tempFilePath) {
      console.warn("[go-ipc-bench] Skipped: Client or temp file missing.");
      return;
    }

    const iterations = 50;
    const chunkSize = 512 * 1024;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const res = await client.request<{ data: string; bytes: number }>("file.chunk", {
        path: tempFilePath,
        index: 0,
        chunkSize: chunkSize,
      });
      expect(res.bytes).toBe(chunkSize);
      expect(res.data).toBeDefined();
    }

    const totalMs = performance.now() - start;
    const avgMs = totalMs / iterations;
    const throughputMBps = ((chunkSize * iterations) / (1024 * 1024)) / (totalMs / 1000);

    console.info(`[go-ipc-bench] 512KB file.chunk RPC avg time: ${avgMs.toFixed(2)} ms (${throughputMBps.toFixed(2)} MB/s throughput over stdin/stdout IPC)`);
    expect(avgMs).toBeLessThan(500);
  });
});
