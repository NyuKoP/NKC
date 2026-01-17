import { spawn } from "node:child_process";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

type TorManagerState = {
  running: boolean;
  pid?: number;
};

export class TorManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private state: TorManagerState = { running: false };

  async start(binaryPath: string, socksPort: number, dataDir: string) {
    if (this.process) return;
    const args = ["--SocksPort", `127.0.0.1:${socksPort}`, "--DataDirectory", dataDir];
    this.process = spawn(binaryPath, args, { stdio: "ignore" });
    this.state = { running: true, pid: this.process.pid };
    this.process.on("exit", () => {
      this.state = { running: false };
      this.process = null;
    });
  }

  async stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.state = { running: false };
  }

  getState() {
    return this.state;
  }
}
