import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type alternateRouteManagerState = {
  running: boolean;
  pid?: number;
};

export class alternateRouteManager {
  private process: ChildProcess | null = null;
  private state: alternateRouteManagerState = { running: false };

  async start(binaryPath: string, socksPort: number, dataDir: string) {
    if (this.process) return;
    const args = ["--socks-port", String(socksPort), "--data-dir", dataDir];
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
