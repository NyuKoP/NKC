import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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

type StatusListener = (status: TorStatus) => void;

const TOR_ENV_PATH = "NKC_TOR_PATH";
const DEFAULT_SOCKS_PORT = 9050;
const START_TIMEOUT_MS = 8000;
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

const waitForPort = async (port: number, timeoutMs: number) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
  private socksPort: number | null = null;
  private dataDir: string;
  private hsConfig: HiddenServiceConfig | null = null;

  constructor(opts: { appDataDir: string }) {
    this.dataDir = path.join(opts.appDataDir, "nkc-tor");
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

  async start() {
    if (this.process) return;
    const torPath = await this.resolveTorPath();
    if (!torPath) {
      this.emit({ state: "unavailable", details: "tor-binary-not-found" });
      return;
    }
    this.emit({ state: "starting", details: "starting-tor" });
    await fsPromises.mkdir(this.dataDir, { recursive: true });
    const socksPort = await getAvailablePort();
    this.socksPort = socksPort;
    const torrcPath = path.join(this.dataDir, "torrc");
    await fsPromises.writeFile(this.buildTorrc(socksPort, this.hsConfig), torrcPath, "utf8");
    this.process = spawn(torPath, ["-f", torrcPath], { stdio: "ignore" });
    this.process.once("exit", () => {
      this.process = null;
      this.emit({ state: "failed", details: "tor-exited" });
    });
    const ready = await waitForPort(socksPort, START_TIMEOUT_MS);
    if (!ready) {
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
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.socksPort = null;
    this.emit({ state: "unavailable", details: "stopped" });
  }

  getStatus() {
    return this.status;
  }

  async ensureHiddenService(opts: { localPort: number; virtPort: number }) {
    this.hsConfig = opts;
    if (this.process) {
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
