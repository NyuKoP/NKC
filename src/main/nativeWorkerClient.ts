import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { coldStartTelemetry as cold } from "./coldStartTelemetry";

const FRAME_PREFIX_BYTES = 8;

const MAX_FRAME_HEADER_BYTES = 1024 * 1024;

const MAX_FRAME_BODY_BYTES = 32 * 1024 * 1024;

type WorkerResponse = {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  resultEncoding?: string;
};

type PendingRequest = {
  resolve: (value: { result: unknown; body: Buffer }) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class NativeWorkerClient {
  private readonly executablePath: string;
  private readonly expectedSha256: string | undefined;
  private process: ChildProcessWithoutNullStreams | null = null;
  private instanceId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(executablePath: string, expectedSha256?: string) {
    this.executablePath = executablePath;
    this.expectedSha256 = expectedSha256;
  }

  async start() {
    if (this.process) return;

    if (this.expectedSha256 !== undefined) {
      cold.mark("worker.integrity.begin");

      if (!/^[a-f0-9]{64}$/.test(this.expectedSha256)) throw new Error("native_worker_integrity_pin_missing");

      const actual = createHash("sha256").update(readFileSync(this.executablePath)).digest("hex");

      if (actual !== this.expectedSha256) throw new Error("native_worker_integrity_mismatch");
      cold.mark("worker.integrity.ok");
    }

    const child = spawn(this.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.instanceId = randomUUID();
    child.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();

      if (message) console.warn("[native-worker]", message);
    });
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      const error = new Error(`native_worker_exited:${code ?? signal ?? "unknown"}`);

      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }

      this.pending.clear();
    });
    child.once("error", (error) => {
      if (this.process === child) this.process = null;

      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }

      this.pending.clear();
    });
    await this.request("health", {}, 5_000);
  }

  getInstanceId() {
    if (!this.process || !this.instanceId) throw new Error("native_worker_unavailable");

    return this.instanceId;
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const response = await this.requestFrame(method, params, Buffer.alloc(0), timeoutMs);

    return response.result as T;
  }

  async requestBinary<T>(
    method: string,
    params: unknown,
    body: Uint8Array | Buffer = Buffer.alloc(0),
    timeoutMs = 30_000
  ): Promise<{ result: T; body: Buffer }> {
    const response = await this.requestFrame(method, params, Buffer.from(body), timeoutMs);

    return { result: response.result as T, body: response.body };
  }

  private async requestFrame(
    method: string,
    params: unknown,
    body: Buffer,
    timeoutMs: number
  ): Promise<{ result: unknown; body: Buffer }> {
    const child = this.process;

    if (!child || child.stdin.destroyed) throw new Error("native_worker_unavailable");
    const id = randomUUID();

    if (body.byteLength > MAX_FRAME_BODY_BYTES) throw new Error("native_worker_body_too_large");

    return new Promise<{ result: unknown; body: Buffer }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native_worker_timeout:${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout,
      });
      const header = Buffer.from(JSON.stringify({ id, method, params }), "utf8");

      if (header.byteLength > MAX_FRAME_HEADER_BYTES) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error("native_worker_header_too_large"));

        return;
      }

      const prefix = Buffer.allocUnsafe(FRAME_PREFIX_BYTES);
      prefix.writeUInt32BE(header.byteLength, 0);
      prefix.writeUInt32BE(body.byteLength, 4);
      child.stdin.write(Buffer.concat([prefix, header, body]), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);

        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  async stop() {
    const child = this.process;

    if (!child) return;
    this.process = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
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

  private handleData(chunk: Buffer) {
    this.stdoutBuffer = this.stdoutBuffer.length
      ? Buffer.concat([this.stdoutBuffer, chunk])
      : chunk;

    while (this.stdoutBuffer.length >= FRAME_PREFIX_BYTES) {
      const headerLength = this.stdoutBuffer.readUInt32BE(0);
      const bodyLength = this.stdoutBuffer.readUInt32BE(4);

      if (headerLength > MAX_FRAME_HEADER_BYTES || bodyLength > MAX_FRAME_BODY_BYTES) {
        this.process?.kill();

        return;
      }

      const frameLength = FRAME_PREFIX_BYTES + headerLength + bodyLength;

      if (this.stdoutBuffer.length < frameLength) return;
      const header = this.stdoutBuffer.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + headerLength);
      const body = Buffer.from(this.stdoutBuffer.subarray(FRAME_PREFIX_BYTES + headerLength, frameLength));
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength);
      this.handleFrame(header, body);
    }
  }

  private handleFrame(header: Buffer, body: Buffer) {
    let payload: WorkerResponse;

    try {
      payload = JSON.parse(header.toString("utf8")) as WorkerResponse;
    } catch {
      return;
    }

    if (!payload.id) return;
    const pending = this.pending.get(payload.id);

    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timeout);

    if (payload.ok) {
      if (payload.resultEncoding !== undefined) {
        if (payload.resultEncoding !== "json") {
          pending.reject(new Error("native_worker_response_encoding_invalid"));
          return;
        }
        try { payload.result = JSON.parse(body.toString("utf8")); }
        catch { pending.reject(new Error("native_worker_response_json_invalid")); return; }
      }
      pending.resolve({ result: payload.result, body });
    } else pending.reject(new Error(payload.error || "native_worker_error"));
  }
}
