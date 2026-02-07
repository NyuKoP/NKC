import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { session } from "electron";
import { getBinaryPath } from "../componentRegistry";
import type { OnionNetwork } from "../../../net/netConfig";
import { readCurrentPointer } from "../install/swapperRollback";
import { TorManager } from "./torManager";
import { LokinetManager } from "./lokinetManager";

type RuntimeStatus = {
  status: "idle" | "starting" | "running" | "failed";
  network?: OnionNetwork;
  socksPort?: number;
  error?: string;
};

const PORT_START = 9050;
const PORT_END = 9070;

const findAvailablePort = async () => {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    const isFree = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (isFree) return port;
  }
  throw new Error("No available SOCKS port");
};

const waitForPort = async (
  port: number,
  timeoutMs = 30000,
  getFailure?: () => string | null
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const failure = getFailure?.();
    if (failure) {
      throw new Error(failure);
    }
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const failure = getFailure?.();
  if (failure) {
    throw new Error(failure);
  }
  throw new Error(`SOCKS proxy not ready (port ${port})`);
};

export class OnionRuntime {
  private torManager = new TorManager();
  private lokinetManager = new LokinetManager();
  private status: RuntimeStatus = { status: "idle" };

  private findInPath(binName: string) {
    const envPath = process.env.PATH ?? "";
    const parts = envPath.split(path.delimiter);
    for (const part of parts) {
      const full = path.join(part, binName);
      if (fsSync.existsSync(full)) return full;
    }
    return null;
  }

  private resolveSystemTorBinaryPath() {
    const binName = process.platform === "win32" ? "tor.exe" : "tor";
    const fromPath = this.findInPath(binName);
    const candidates = [
      process.env.NKC_SYSTEM_TOR_BIN?.trim(),
      fromPath,
      "/opt/homebrew/bin/tor",
      "/usr/local/bin/tor",
      "/opt/local/bin/tor",
      "/usr/bin/tor",
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private async waitForTorSocks(port: number) {
    await waitForPort(port, 90000, () => {
      const state = this.torManager.getState();
      if (!state.running) {
        return state.error ?? "Tor exited before SOCKS became ready";
      }
      return null;
    });
  }

  private async startTorWithFallback(binaryPath: string, port: number, dataDir: string) {
    const attempts: string[] = [];
    const systemTorBinary =
      process.platform === "darwin" ? this.resolveSystemTorBinaryPath() : null;
    const tryStart = async (
      label: string,
      candidatePath: string,
      mode: "torrc" | "cli"
    ) => {
      try {
        await this.torManager.start(candidatePath, port, dataDir, mode);
        await this.waitForTorSocks(port);
        return true;
      } catch (error) {
        const state = this.torManager.getState();
        const detail = state.logTail ? ` | ${state.logTail}` : "";
        const message = error instanceof Error ? error.message : String(error);
        attempts.push(`${label}: ${message}${detail}`);
        await this.torManager.stop();
        return false;
      }
    };
    const trySystemTor = async () => {
      if (!systemTorBinary) return false;
      if (path.resolve(systemTorBinary) === path.resolve(binaryPath)) return false;
      return tryStart(`system-cli(${systemTorBinary})`, systemTorBinary, "cli");
    };

    if (await tryStart("bundled-torrc", binaryPath, "torrc")) return;
    // On macOS, SIGKILL often means the bundled binary was blocked by policy/runtime checks.
    // If that happens, prefer immediate fallback to a system Tor binary.
    if (
      process.platform === "darwin" &&
      (this.torManager.getState().error ?? "").includes("signal=SIGKILL") &&
      (await trySystemTor())
    ) {
      return;
    }
    if (await tryStart("bundled-cli", binaryPath, "cli")) return;
    if (await trySystemTor()) return;

    throw new Error(`Tor SOCKS startup failed after retry: ${attempts.join(" || ")}`);
  }

  async start(userDataDir: string, network: OnionNetwork) {
    if (this.status.status === "running" && this.status.network === network) return;
    await this.stop();
    this.status = { status: "starting", network };
    try {
      const pointer = await readCurrentPointer(userDataDir, network);
      if (!pointer) {
        throw new Error("Component not installed");
      }

      const port = await findAvailablePort();
      const dataDir = path.join(userDataDir, "onion", "runtime", network);
      await fs.mkdir(dataDir, { recursive: true });
      const binaryPath = path.join(pointer.path, getBinaryPath(network));
      if (!fsSync.existsSync(binaryPath)) {
        throw new Error(`BINARY_MISSING: ${binaryPath}`);
      }

      if (network === "tor") {
        await this.startTorWithFallback(binaryPath, port, dataDir);
      } else {
        await this.lokinetManager.start(binaryPath, port, dataDir);
        await waitForPort(port, 30000);
      }
      await session.defaultSession.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
      this.status = { status: "running", network, socksPort: port };
    } catch (error) {
      this.status = {
        status: "failed",
        network,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stop() {
    await this.torManager.stop();
    await this.lokinetManager.stop();
    await session.defaultSession.setProxy({ mode: "direct" });
    this.status = { status: "idle" };
  }

  getStatus() {
    return {
      ...this.status,
      tor: this.torManager.getState(),
      lokinet: this.lokinetManager.getState(),
    };
  }
}
