import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readCurrentPointer } from "./onion/install/swapperRollback";
import { getBinaryPath } from "./onion/componentRegistry";

export type TorStatus =
  | { state: "unavailable"; details?: string }
  | { state: "starting"; details?: string }
  | { state: "running"; socksProxyUrl: string; dataDir: string; details?: string }
  | { state: "failed"; details: string };

type HiddenServiceConfig = {
  localPort: number;
  virtPort: number;
};

type TorStartOptions = {
  profileScopedDataDir?: boolean;
};

type StatusListener = (status: TorStatus) => void;

const TOR_ENV_PATH = "NKC_TOR_PATH";
const DEFAULT_SOCKS_PORT = 9050;
const START_TIMEOUT_MS = 30000;
const HOSTNAME_TIMEOUT_MS = 15000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findInPath = (binName: string) => {
  const envPath = process.env.PATH ?? "";
  const parts = envPath.split(path.delimiter);
  for (const part of parts) {
    const full = path.join(part, binName);
    if (fs.existsSync(full)) return full;
  }
  return null;
};

const isPortFree = async (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });

const getAvailablePort = async () => {
  if (await isPortFree(DEFAULT_SOCKS_PORT)) return DEFAULT_SOCKS_PORT;
  return new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : DEFAULT_SOCKS_PORT;
      server.close(() => resolve(port));
    });
  });
};

const waitForPort = async (port: number, timeoutMs: number, shouldAbort?: () => boolean) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (shouldAbort?.()) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
};

const waitForHostname = async (filePath: string, timeoutMs: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await fsPromises.readFile(filePath, "utf8");
      const line = raw.trim();
      if (line.endsWith(".onion")) return line;
    } catch {
      // ignore
    }
    await sleep(500);
  }
  throw new Error("hidden_service_hostname_unavailable");
};

export class TorManager {
  private process: ChildProcess | null = null;
  private status: TorStatus = { state: "unavailable", details: "not-started" };
  private listeners = new Set<StatusListener>();
  private torPath: string | null = null;
  private readonly baseDataDir: string;
  private dataDir: string;
  private hsConfig: HiddenServiceConfig | null = null;
  private logTail = "";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private ensureHiddenServicePromise: Promise<{ onionHost: string }> | null = null;
  private expectProcessExit = false;

  constructor(opts: { appDataDir: string }) {
    this.baseDataDir = path.join(opts.appDataDir, "nkc-tor");
    this.dataDir = this.baseDataDir;
  }

  private emit(next: TorStatus) {
    this.status = next;
    this.listeners.forEach((cb) => cb(next));
  }

  private async resolveTorPath() {
    if (this.torPath) return this.torPath;
    const envPath = process.env[TOR_ENV_PATH];
    if (envPath && fs.existsSync(envPath)) {
      this.torPath = envPath;
      return this.torPath;
    }

    const pointer = await readCurrentPointer(path.dirname(this.dataDir), "tor");
    if (pointer?.path) {
      const candidate = path.join(pointer.path, getBinaryPath("tor"));
      if (fs.existsSync(candidate)) {
        this.torPath = candidate;
        return this.torPath;
      }
    }

    const binName = process.platform === "win32" ? "tor.exe" : "tor";
    const fromPath = findInPath(binName);
    if (fromPath) {
      this.torPath = fromPath;
      return this.torPath;
    }
    return null;
  }

  private appendLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const next = `${this.logTail}${text}`.slice(-4096);
    this.logTail = next.trim();
  }

  private resolveBundleRoot(torPath: string) {
    const candidate = path.dirname(path.dirname(torPath));
    const defaultsPath = path.join(candidate, "data", "torrc-defaults");
    return fs.existsSync(defaultsPath) ? candidate : undefined;
  }

  private async ensureExecutable(torPath: string) {
    if (process.platform === "win32") return;
    try {
      await fsPromises.chmod(torPath, 0o755);
    } catch {
      // Best effort; spawn error handling will surface failures.
    }
  }

  private async clearMacQuarantine(torPath: string) {
    if (process.platform !== "darwin") return;
    await new Promise<void>((resolve) => {
      execFile("xattr", ["-dr", "com.apple.quarantine", torPath], () => resolve());
    });
  }

  private buildTorrc(socksPort: number, hsConfig?: HiddenServiceConfig | null) {
    const lines = [
      `DataDirectory ${this.dataDir}`,
      `SocksPort 127.0.0.1:${socksPort}`,
    ];
    if (hsConfig) {
      const hsDir = path.join(this.dataDir, "hs-onion");
      lines.push(`HiddenServiceDir ${hsDir}`);
      lines.push(`HiddenServicePort ${hsConfig.virtPort} 127.0.0.1:${hsConfig.localPort}`);
    }
    return lines.join("\n");
  }

  private resolveDataDir(opts?: TorStartOptions) {
    if (!opts?.profileScopedDataDir) return this.baseDataDir;
    const suffix = `profile-${process.pid}`;
    return `${this.baseDataDir}-${suffix}`;
  }

  private isDataDirConflict(details: string | undefined) {
    if (!details) return false;
    return details.toLowerCase().includes("another tor process is running with the same data directory");
  }

  private isStartingStatus() {
    return this.status.state === "starting";
  }

  async start(opts?: TorStartOptions) {
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(opts).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(opts?: TorStartOptions) {
    if (this.process) return;
    const torPath = await this.resolveTorPath();
    if (!torPath) {
      this.emit({ state: "unavailable", details: "tor-binary-not-found" });
      return;
    }
    this.dataDir = this.resolveDataDir(opts);
    this.logTail = "";
    this.emit({ state: "starting", details: "starting-tor" });
    await fsPromises.mkdir(this.dataDir, { recursive: true });
    const socksPort = await getAvailablePort();
    const torrcPath = path.join(this.dataDir, "torrc");
    await fsPromises.writeFile(torrcPath, this.buildTorrc(socksPort, this.hsConfig), "utf8");
    await this.ensureExecutable(torPath);
    await this.clearMacQuarantine(torPath);
    if (!this.isStartingStatus()) return;
    this.expectProcessExit = false;
    this.process = spawn(torPath, ["-f", torrcPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.resolveBundleRoot(torPath),
    });
    this.process.stdout?.on("data", (chunk) => this.appendLog(chunk));
    this.process.stderr?.on("data", (chunk) => this.appendLog(chunk));
    this.process.once("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.process = null;
      this.expectProcessExit = false;
      this.emit({ state: "failed", details: `tor-spawn-failed: ${detail}` });
    });
    this.process.once("exit", (code, signal) => {
      const expectedExit = this.expectProcessExit;
      this.process = null;
      this.expectProcessExit = false;
      if (expectedExit) return;
      const tail = this.logTail ? ` | ${this.logTail}` : "";
      this.emit({
        state: "failed",
        details: `tor-exited(code=${code ?? "null"},signal=${signal ?? "none"})${tail}`,
      });
    });
    const ready = await waitForPort(socksPort, START_TIMEOUT_MS, () => !this.isStartingStatus());
    if (!ready) {
      if (this.status.state === "failed" && this.isDataDirConflict(this.status.details)) {
        return;
      }
      if (this.status.state === "failed") {
        return;
      }
      if (!this.isStartingStatus()) {
        return;
      }
      this.emit({ state: "failed", details: "socks-not-ready" });
      await this.stop();
      return;
    }
    this.emit({
      state: "running",
      socksProxyUrl: `socks5://127.0.0.1:${socksPort}`,
      dataDir: this.dataDir,
    });
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopInternal() {
    const proc = this.process;
    if (!proc) {
      this.expectProcessExit = false;
      this.emit({ state: "unavailable", details: "stopped" });
      return;
    }
    this.expectProcessExit = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.once("exit", finish);
      try {
        proc.kill();
      } catch {
        finish();
      }
      setTimeout(finish, 3000);
    });
    this.process = null;
    this.emit({ state: "unavailable", details: "stopped" });
  }

  getStatus() {
    return this.status;
  }

  async ensureHiddenService(opts: { localPort: number; virtPort: number }) {
    if (this.ensureHiddenServicePromise) return this.ensureHiddenServicePromise;
    this.ensureHiddenServicePromise = this.ensureHiddenServiceInternal(opts).finally(() => {
      this.ensureHiddenServicePromise = null;
    });
    return this.ensureHiddenServicePromise;
  }

  private async ensureHiddenServiceInternal(opts: { localPort: number; virtPort: number }) {
    const hsChanged =
      !this.hsConfig ||
      this.hsConfig.localPort !== opts.localPort ||
      this.hsConfig.virtPort !== opts.virtPort;
    this.hsConfig = opts;
    if (hsChanged && this.process) {
      await this.stop();
    }
    await this.start();
    if (this.status.state !== "running") {
      throw new Error(this.status.state === "failed" ? this.status.details : "tor-unavailable");
    }
    const hsDir = path.join(this.dataDir, "hs-onion");
    const hostnamePath = path.join(hsDir, "hostname");
    const onionHost = await waitForHostname(hostnamePath, HOSTNAME_TIMEOUT_MS);
    return { onionHost };
  }

  onStatus(cb: (s: TorStatus) => void) {
    this.listeners.add(cb);
    cb(this.status);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
