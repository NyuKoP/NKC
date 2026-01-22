import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readCurrentPointer } from "./onion/install/swapperRollback";
import { getBinaryPath } from "./onion/componentRegistry";

export type alternateRouteStatus =
  | { state: "unavailable"; details?: string }
  | { state: "stopped"; details?: string }
  | { state: "starting"; details?: string }
  | { state: "running"; proxyUrl: string; serviceAddress?: string; details?: string }
  | { state: "failed"; details: string };

type StatusListener = (status: alternateRouteStatus) => void;

const alternateRoute_ENV_PATH = "NKC_alternateRoute_PATH";
const DEFAULT_SOCKS_PORT = 22000;
const START_TIMEOUT_MS = 8000;

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

const isValidSocksUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "socks5:" || url.protocol === "socks5h:";
  } catch {
    return false;
  }
};

export class alternateRouteManager {
  private process: ChildProcess | null = null;
  private status: alternateRouteStatus = { state: "stopped", details: "not-started" };
  private listeners = new Set<StatusListener>();
  private alternateRoutePath: string | null = null;
  private dataDir: string;
  private serviceAddress: string | undefined;

  constructor(opts: { appDataDir: string }) {
    this.dataDir = path.join(opts.appDataDir, "nkc-alternateRoute");
  }

  private emit(next: alternateRouteStatus) {
    this.status = next;
    this.listeners.forEach((cb) => cb(next));
  }

  private async resolvealternateRoutePath() {
    if (this.alternateRoutePath) return this.alternateRoutePath;
    const envPath = process.env[alternateRoute_ENV_PATH];
    if (envPath && fs.existsSync(envPath)) {
      this.alternateRoutePath = envPath;
      return this.alternateRoutePath;
    }
    const pointer = await readCurrentPointer(path.dirname(this.dataDir), "alternateRoute");
    if (pointer?.path) {
      const candidate = path.join(pointer.path, getBinaryPath("alternateRoute"));
      if (fs.existsSync(candidate)) {
        this.alternateRoutePath = candidate;
        return this.alternateRoutePath;
      }
    }
    const binName = process.platform === "win32" ? "alternateRoute.exe" : "alternateRoute";
    const fromPath = findInPath(binName);
    if (fromPath) {
      this.alternateRoutePath = fromPath;
      return this.alternateRoutePath;
    }
    return null;
  }

  async configureExternal(opts: { proxyUrl: string; serviceAddress?: string }) {
    if (!isValidSocksUrl(opts.proxyUrl)) {
      this.emit({ state: "failed", details: "invalid-alternateRoute-proxy" });
      return;
    }
    this.serviceAddress = opts.serviceAddress?.trim() || undefined;
    this.emit({
      state: "running",
      proxyUrl: opts.proxyUrl,
      serviceAddress: this.serviceAddress,
      details: "external proxy configured (unverified)",
    });
  }

  async start() {
    if (this.process) return;
    const binaryPath = await this.resolvealternateRoutePath();
    if (!binaryPath) {
      this.emit({ state: "unavailable", details: "alternateRoute-binary-not-found" });
      return;
    }
    this.emit({ state: "starting", details: "starting-alternateRoute" });
    await fsPromises.mkdir(this.dataDir, { recursive: true });
    const socksPort = await getAvailablePort();
    this.process = spawn(binaryPath, ["--socks-port", String(socksPort), "--data-dir", this.dataDir], {
      stdio: "ignore",
    });
    this.process.once("exit", () => {
      this.process = null;
      this.emit({ state: "failed", details: "alternateRoute-exited" });
    });
    const ready = await waitForPort(socksPort, START_TIMEOUT_MS);
    if (!ready) {
      this.emit({ state: "failed", details: "alternateRoute-socks-not-ready" });
      await this.stop();
      return;
    }
    this.emit({
      state: "running",
      proxyUrl: `socks5://127.0.0.1:${socksPort}`,
      serviceAddress: this.serviceAddress,
      details: this.serviceAddress ? undefined : "service-address-unavailable",
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.emit({ state: "stopped", details: "stopped" });
  }

  getStatus() {
    return this.status;
  }

  onStatus(cb: (s: alternateRouteStatus) => void) {
    this.listeners.add(cb);
    cb(this.status);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
