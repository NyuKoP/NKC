import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const root = process.cwd();
const executableName = process.platform === "win32" ? "nkc-worker.exe" : "nkc-worker";
const executablePath = path.join(root, "native", "bin", executableName);

if (!fs.existsSync(executablePath)) {
  console.error("[bench-go-ipc] Go worker binary not found. Run npm run bench:ipc to build it first.");
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_ITERATIONS = 500;
const CHUNK_ITERATIONS = 200;
const WARMUP_ITERATIONS = 10;

class BenchmarkWorkerClient {
  constructor(binPath) {
    this.binPath = binPath;
    this.process = null;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
  }

  async start() {
    const child = spawn(this.binPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.warn("[bench-worker]", message);
    });
    child.once("error", (error) => this.rejectPending(error));
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      this.rejectPending(new Error(`worker_exited:${code ?? signal ?? "unknown"}`));
    });
    await this.request("health", {});
  }

  async request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return this.requestFrame(method, params, Buffer.alloc(0), timeoutMs);
  }

  async requestBinary(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return this.requestFrame(method, params, Buffer.alloc(0), timeoutMs);
  }

  async requestFrame(method, params, body, timeoutMs) {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("worker_unavailable");
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const header = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
      const prefix = Buffer.allocUnsafe(8);
      prefix.writeUInt32BE(header.byteLength, 0);
      prefix.writeUInt32BE(body.byteLength, 4);
      const frame = Buffer.concat([prefix, header, body]);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        requestWireBytes: frame.byteLength,
      });
      child.stdin.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  handleData(chunk) {
    this.stdoutBuffer = this.stdoutBuffer.length
      ? Buffer.concat([this.stdoutBuffer, chunk])
      : chunk;
    while (this.stdoutBuffer.length >= 8) {
      const headerLength = this.stdoutBuffer.readUInt32BE(0);
      const bodyLength = this.stdoutBuffer.readUInt32BE(4);
      const frameLength = 8 + headerLength + bodyLength;
      if (this.stdoutBuffer.length < frameLength) return;
      const header = this.stdoutBuffer.subarray(8, 8 + headerLength);
      const body = Buffer.from(this.stdoutBuffer.subarray(8 + headerLength, frameLength));
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength);
      try {
        const payload = JSON.parse(header.toString("utf8"));
        if (!payload.id || !this.pending.has(payload.id)) continue;
        const req = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        clearTimeout(req.timeout);
        const responseWireBytes = frameLength;
        if (payload.ok) {
          req.resolve({
            result: payload.result,
            body,
            requestWireBytes: req.requestWireBytes,
            responseWireBytes,
            totalWireBytes: req.requestWireBytes + responseWireBytes,
          });
        } else req.reject(new Error(payload.error || "worker_error"));
      } catch (err) {
        console.error("[bench-worker] frame parse error:", err);
      }
    }
  }

  async stop() {
    const child = this.process;
    if (!child) return;
    this.process = null;
    child.stdin.end();
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function calculatePercentiles(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return { mean, p50, p95, p99, min, max };
}

function formatWireStats(total, iterations) {
  return {
    requestKiB: total.request / iterations / 1024,
    responseKiB: total.response / iterations / 1024,
    totalKiB: total.combined / iterations / 1024,
  };
}

async function measureRequests(client, iterations, method, params, binary = false) {
  const latencies = [];
  const wire = { request: 0, response: 0, combined: 0 };
  for (let i = 0; i < iterations; i++) {
    const startedAt = performance.now();
    const response = binary
      ? await client.requestBinary(method, params)
      : await client.request(method, params);
    latencies.push(performance.now() - startedAt);
    wire.request += response.requestWireBytes;
    wire.response += response.responseWireBytes;
    wire.combined += response.totalWireBytes;
  }
  return { latencies, wire };
}

async function runBenchmark() {
  console.log("[bench-go-ipc] Initializing Go Worker IPC Benchmark...");
  const client = new BenchmarkWorkerClient(executablePath);
  await client.start();

  // Create 1MiB temp file
  const tempPath = path.join(root, "node_modules", ".cache", "go-ipc-standalone-bench.tmp");
  const dir = path.dirname(tempPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sample = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(tempPath, sample);

  try {
    // 1. Warmup
    console.log(`[bench-go-ipc] Warming up (${WARMUP_ITERATIONS} iterations)...`);
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      await client.request("health", {});
      await client.requestBinary("file.chunk.binary", { path: tempPath, index: 0, chunkSize: 512 * 1024 });
      await client.requestBinary("file.chunk.binary", { path: tempPath, index: 0, chunkSize: 1024 * 1024 });
    }

    console.log(`\n--- Benchmark 1: Health RPC Latency (${HEALTH_ITERATIONS} iterations) ---`);
    const health = await measureRequests(client, HEALTH_ITERATIONS, "health", {});
    const hStats = calculatePercentiles(health.latencies);
    const healthWire = formatWireStats(health.wire, HEALTH_ITERATIONS);
    console.log(`Mean: ${hStats.mean.toFixed(3)} ms | P50: ${hStats.p50.toFixed(3)} ms | P95: ${hStats.p95.toFixed(3)} ms | P99: ${hStats.p99.toFixed(3)} ms | Min: ${hStats.min.toFixed(3)} ms | Max: ${hStats.max.toFixed(3)} ms`);
    console.log(`Avg Wire: ${(healthWire.totalKiB * 1024).toFixed(0)} bytes total (${(healthWire.requestKiB * 1024).toFixed(0)} request + ${(healthWire.responseKiB * 1024).toFixed(0)} response)`);

    console.log(`\n--- Benchmark 2: 512KiB Chunk IPC Throughput (${CHUNK_ITERATIONS} iterations) ---`);
    const chunkSize512 = 512 * 1024;
    const chunk512 = await measureRequests(client, CHUNK_ITERATIONS, "file.chunk.binary", {
      path: tempPath,
      index: 0,
      chunkSize: chunkSize512,
    }, true);
    const c512Stats = calculatePercentiles(chunk512.latencies);
    const totalMiB512 = (chunkSize512 * CHUNK_ITERATIONS) / (1024 * 1024);
    const totalTimeSec512 = chunk512.latencies.reduce((a, b) => a + b, 0) / 1000;
    const throughput512 = totalMiB512 / totalTimeSec512;
    const chunk512Wire = formatWireStats(chunk512.wire, CHUNK_ITERATIONS);

    console.log(`Mean: ${c512Stats.mean.toFixed(2)} ms | P50: ${c512Stats.p50.toFixed(2)} ms | P95: ${c512Stats.p95.toFixed(2)} ms | P99: ${c512Stats.p99.toFixed(2)} ms`);
    console.log(`Throughput: ${throughput512.toFixed(2)} MiB/s (Payload: ${chunkSize512 / 1024} KiB, Avg Wire: ${chunk512Wire.totalKiB.toFixed(2)} KiB total = ${chunk512Wire.requestKiB.toFixed(2)} request + ${chunk512Wire.responseKiB.toFixed(2)} response)`);

    console.log(`\n--- Benchmark 3: 1MiB Chunk IPC Throughput (${CHUNK_ITERATIONS} iterations) ---`);
    const chunkSize1024 = 1024 * 1024;
    const chunk1024 = await measureRequests(client, CHUNK_ITERATIONS, "file.chunk.binary", {
      path: tempPath,
      index: 0,
      chunkSize: chunkSize1024,
    }, true);
    const c1024Stats = calculatePercentiles(chunk1024.latencies);
    const totalMiB1024 = (chunkSize1024 * CHUNK_ITERATIONS) / (1024 * 1024);
    const totalTimeSec1024 = chunk1024.latencies.reduce((a, b) => a + b, 0) / 1000;
    const throughput1024 = totalMiB1024 / totalTimeSec1024;
    const chunk1024Wire = formatWireStats(chunk1024.wire, CHUNK_ITERATIONS);

    console.log(`Mean: ${c1024Stats.mean.toFixed(2)} ms | P50: ${c1024Stats.p50.toFixed(2)} ms | P95: ${c1024Stats.p95.toFixed(2)} ms | P99: ${c1024Stats.p99.toFixed(2)} ms`);
    console.log(`Throughput: ${throughput1024.toFixed(2)} MiB/s (Payload: ${chunkSize1024 / 1024} KiB, Avg Wire: ${chunk1024Wire.totalKiB.toFixed(2)} KiB total = ${chunk1024Wire.requestKiB.toFixed(2)} request + ${chunk1024Wire.responseKiB.toFixed(2)} response)`);

  } finally {
    await client.stop();
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        console.warn("[bench-go-ipc] Failed to clean up temp file:", error);
      }
    }
  }
}

runBenchmark().catch((err) => {
  console.error("[bench-go-ipc] Benchmark error:", err);
  process.exit(1);
});
