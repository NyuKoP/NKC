import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

type WorkerResponse = {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class NativeWorkerClient {
  private readonly executablePath: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(executablePath: string) {
    this.executablePath = executablePath;
  }

  async start() {
    if (this.process) return;
    const child = spawn(this.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
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

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("native_worker_unavailable");
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native_worker_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
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

  private handleLine(line: string) {
    let payload: WorkerResponse;
    try {
      payload = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }
    if (!payload.id) return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timeout);
    if (payload.ok) pending.resolve(payload.result);
    else pending.reject(new Error(payload.error || "native_worker_error"));
  }
}
