import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type TorManagerState = {
  running: boolean;
  pid?: number;
  error?: string;
  logTail?: string;
};

type TorStartMode = "torrc" | "cli";

export class TorManager {
  private process: ChildProcess | null = null;
  private state: TorManagerState = { running: false };
  private logTail = "";

  private buildTorrc(socksPort: number, dataDir: string) {
    const lines = [
      `DataDirectory ${dataDir}`,
      `SocksPort 127.0.0.1:${socksPort}`,
    ];
    return lines.join("\n");
  }

  private appendLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const next = `${this.logTail}${text}`.slice(-4096);
    this.logTail = next.trim();
  }

  private setFailure(message: string) {
    this.state = { running: false, error: message, logTail: this.logTail || undefined };
    this.process = null;
  }

  private async ensureExecutable(binaryPath: string) {
    if (process.platform === "win32") return;
    try {
      await fs.chmod(binaryPath, 0o755);
    } catch {
      // Best effort: runtime will still report spawn error if execution is blocked.
    }
  }

  private async clearMacQuarantine(binaryPath: string) {
    if (process.platform !== "darwin") return;
    await new Promise<void>((resolve) => {
      execFile("xattr", ["-dr", "com.apple.quarantine", binaryPath], () => resolve());
    });
  }

  async start(
    binaryPath: string,
    socksPort: number,
    dataDir: string,
    mode: TorStartMode = "torrc"
  ) {
    if (this.process) return;
    this.logTail = "";
    await this.ensureExecutable(binaryPath);
    await this.clearMacQuarantine(binaryPath);
    let args: string[];
    if (mode === "torrc") {
      await fs.mkdir(dataDir, { recursive: true });
      const torrcPath = path.join(dataDir, "torrc");
      await fs.writeFile(torrcPath, this.buildTorrc(socksPort, dataDir), "utf8");
      args = ["-f", torrcPath];
    } else {
      args = ["--SocksPort", `127.0.0.1:${socksPort}`, "--DataDirectory", dataDir];
    }
    const bundleRoot = path.dirname(path.dirname(binaryPath));
    await this.clearMacQuarantine(bundleRoot);
    const hasBundleDefaults = fsSync.existsSync(path.join(bundleRoot, "data", "torrc-defaults"));
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: hasBundleDefaults ? bundleRoot : undefined,
    });
    this.process = child;
    this.state = { running: true, pid: child.pid };
    child.stdout?.on("data", (chunk) => this.appendLog(chunk));
    child.stderr?.on("data", (chunk) => this.appendLog(chunk));
    child.on("error", (error) => {
      // Ignore stale events from a process that has already been replaced.
      if (this.process !== child) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.setFailure(`Tor spawn failed: ${detail}`);
    });
    child.on("exit", (code, signal) => {
      // Ignore stale events from a process that has already been replaced/stopped.
      if (this.process !== child) return;
      const tail = this.logTail ? ` | ${this.logTail}` : "";
      this.setFailure(`Tor exited before ready (code=${code ?? "null"}, signal=${signal ?? "none"})${tail}`);
    });
  }

  async stop() {
    const child = this.process;
    if (!child) {
      this.state = { running: false };
      return;
    }
    // Mark stopped first so late exit events cannot clobber newer process state.
    this.process = null;
    this.state = { running: false };
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      child.once("exit", () => done());
      child.once("error", () => done());
      try {
        child.kill("SIGTERM");
      } catch {
        done();
        return;
      }
      setTimeout(() => {
        if (finished) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        setTimeout(done, 300);
      }, 3000);
    });
  }

  getState() {
    return this.state;
  }
}
