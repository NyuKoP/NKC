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

const waitForPort = async (port: number, timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
  throw new Error(`SOCKS proxy not ready (port ${port})`);
};

export class OnionRuntime {
  private torManager = new TorManager();
  private lokinetManager = new LokinetManager();
  private status: RuntimeStatus = { status: "idle" };

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
        await this.torManager.start(binaryPath, port, dataDir);
      } else {
        await this.lokinetManager.start(binaryPath, port, dataDir);
      }

      await waitForPort(port);
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
