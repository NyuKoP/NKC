import fs from "node:fs";
import { coldStartTelemetry as cold, bootstrapPhases } from "./coldStartTelemetry";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readCurrentPointer } from "./onion/install/swapperRollback";
import { getBinaryPath } from "./onion/componentRegistry";
import { verifyInstalledTor } from "./onion/install/installedTorProvenance";
import { needsLyrebird, resolveBridgeSelection } from "./tor/torCircumvention";
import {
  TorPluginLifecycle,
  TorPollingBackoff,
  type TorPluginState,
} from "./tor/torPluginLifecycle";

export type TorStatus =
  | { state: "unavailable"; details?: string }
  | { state: "starting"; details?: string }
  | { state: "running"; socksProxyUrl: string; dataDir: string; details?: string }
  | { state: "failed"; details: string };

export type TorDiagnostics = {
  state: TorStatus["state"];
  bootstrapProgress: number;
  processRunning: boolean;
  bridgeMode: "direct" | "bridged";
  pluginState: TorPluginState;
  reasonsDisabled: number;
};

type HiddenServiceConfig = {
  localPort: number;
  virtPort: number;
};

type TorStartOptions = {
  profileScopedDataDir?: boolean;
  bridgeMode?: "off" | "auto" | "force";
};

// Immutable caller policy and bounded per-operation fallback are separate.
type TorAttempt = { mode: TorStartOptions["bridgeMode"]; bridgeFallbackUsed: boolean };

type StatusListener = (status: TorStatus) => void;

const TOR_ENV_PATH = "NKC_TOR_PATH";

const TOR_BRIDGES_ENV = "NKC_TOR_BRIDGES";

const TOR_COUNTRY_ENV = "NKC_TOR_COUNTRY";

const DEFAULT_SOCKS_PORT = 9050;

const LAST_PREFERRED_SOCKS_PORT = 9070;

const START_TIMEOUT_MS = 60_000;

const BRIDGE_START_TIMEOUT_MS = 180_000;

const HOSTNAME_TIMEOUT_MS = 15000;

const reservedSocksPorts = new Set<number>();

let portReservationTail = Promise.resolve();

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

const withPortReservationLock = async <T>(work: () => Promise<T>) => {
  const previous = portReservationTail;
  let release!: () => void;
  portReservationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    return await work();
  } finally {
    release();
  }
};

export const reserveTorSocksPort = () =>
  withPortReservationLock(async () => {
    for (
      let port = DEFAULT_SOCKS_PORT;
      port <= LAST_PREFERRED_SOCKS_PORT;
      port += 1
    ) {
      if (reservedSocksPorts.has(port)) continue;

      if (!(await isPortFree(port))) continue;
      reservedSocksPorts.add(port);

      return port;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const selectedPort = typeof addr === "object" && addr ? addr.port : 0;
          server.close(() => resolve(selectedPort));
        });
      });

      if (!port || reservedSocksPorts.has(port)) continue;
      reservedSocksPorts.add(port);

      return port;
    }

    throw new Error("No available SOCKS port");
  });

export const releaseTorSocksPort = (port: number | null | undefined) => {
  if (typeof port === "number") {
    reservedSocksPorts.delete(port);
  }
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

export const parseTorBootstrapProgress = (value: string) => {
  let progress = 0;

  for (const match of value.matchAll(/Bootstrapped\s+(\d{1,3})%/gi)) {
    const parsed = Number.parseInt(match[1] ?? "0", 10);

    if (Number.isFinite(parsed)) progress = Math.max(progress, Math.min(100, parsed));
  }

  return progress;
};

export const waitForBootstrap = async (
  getProgress: () => number,
  timeoutMs: number,
  shouldAbort?: () => boolean,
  progressGraceMs = 0
) => {
  const startedAt = performance.now();
  let highestProgress = getProgress();
  let lastProgressAt = startedAt;

  while (true) {
    if (shouldAbort?.()) return false;
    const now = performance.now();
    const progress = getProgress();

    if (progress >= 100) return true;

    if (progress > highestProgress) {
      highestProgress = progress;
      lastProgressAt = now;
    }

    if (now - startedAt >= timeoutMs) {
      // Preserve a nearly finished, still advancing direct bootstrap instead
      // of discarding its circuits for a bridge restart. Never wait unboundedly.
      if (now - startedAt >= timeoutMs + progressGraceMs ||
          progress < 80 || now - lastProgressAt >= 20_000) return false;
    }

    await sleep(100);
  }
};

const waitForHostname = async (filePath: string, timeoutMs: number) => {
  const startedAt = Date.now();
  const backoff = new TorPollingBackoff(50, 500, 1.2);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await fsPromises.readFile(filePath, "utf8");
      const line = raw.trim();

      if (line.endsWith(".onion")) return line;
    } catch {
      // ignore
    }

    await sleep(backoff.getPollingInterval());
    backoff.increment();
  }

  throw new Error("hidden_service_hostname_unavailable");
};

export class TorManager {
  private readonly traceLane: "primary" | "secondary";
  private traceAttempt = 0;
  private traceStartedAt = 0;
  private traceLastProgressAt = 0;
  private tracePhase: typeof bootstrapPhases[number] = "unknown";
  private traceMode: "direct" | "bridged" = "direct";
  private process: ChildProcess | null = null;
  private status: TorStatus = { state: "unavailable", details: "not-started" };
  private listeners = new Set<StatusListener>();
  private torPath: string | null = null;
  private readonly baseDataDir: string;
  private dataDir: string;
  private hsConfig: HiddenServiceConfig | null = null;
  private logTail = "";
  private bootstrapProgress = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private ensureHiddenServicePromise: Promise<{ onionHost: string }> | null = null;
  private expectProcessExit = false;
  private bridgeDetail: string | null = null;
  private bridgeModeOverride: "off" | "auto" | "force" | null = null;
  private macSignatureRepairAttempted = false;
  private macSystemTorFallbackAttempted = false;
  private reservedSocksPort: number | null = null;
  private readonly lifecycle = new TorPluginLifecycle();

  constructor(opts: { appDataDir: string; instanceId?: string }) {
    this.traceLane = opts.instanceId ? "secondary" : "primary";
    const suffix = opts.instanceId?.trim() ? `-${opts.instanceId.trim()}` : "";
    this.baseDataDir = path.join(opts.appDataDir, `nkc-tor${suffix}`);
    this.dataDir = this.baseDataDir;
  }

  private emit(next: TorStatus) {
    if (next.state === "running" || next.state === "failed") {
      cold.mark(next.state === "running" ? "tor.running" : "tor.start.failed", {
        lane: this.traceLane, attempt: this.traceAttempt,
      });
    }

    this.status = next;
    this.listeners.forEach((cb) => cb(next));
  }

  private async resolveTorPath() {
    const envPath = process.env[TOR_ENV_PATH];
    const userDataDir = path.dirname(this.baseDataDir);
    const pointer = await readCurrentPointer(userDataDir, "tor");

    if (envPath && (!pointer || path.resolve(envPath) !== path.resolve(pointer.path, getBinaryPath("tor"))))
      throw new Error("TOR_UNTRUSTED_OVERRIDE");

    if (!pointer) return null;
    this.torPath = await verifyInstalledTor(userDataDir, pointer);

    return this.torPath;
  }

  private appendLog(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const next = `${this.logTail}${text}`.slice(-4096);
    this.logTail = next.trim();

    if (/Problem bootstrapping|connections? (?:have |has )?failed|connection refused|network is unreachable/i.test(text)) {
      cold.mark("tor.bootstrap.problem", { lane: this.traceLane, attempt: this.traceAttempt,
        mode: this.traceMode, phase: this.tracePhase, progress: this.bootstrapProgress,
        elapsedMs: performance.now() - this.traceStartedAt,
        errorCategory: /timeout|timed out/i.test(text) ? "timeout" : /connection refused/i.test(text) ? "connection_refused" : "unknown" });
    }

    const previousProgress = this.bootstrapProgress;
    this.bootstrapProgress = Math.max(
      this.bootstrapProgress,
      parseTorBootstrapProgress(next)
    );

    if (this.bootstrapProgress > previousProgress) {
      this.traceLastProgressAt = performance.now();

      const progressMatch = [...next.matchAll(/Bootstrapped\s+(\d{1,3})%\s*\(([a-z_]+)\)/gi)]
        .reverse().find((match) => Number(match[1]) === this.bootstrapProgress);

      this.tracePhase = bootstrapPhases.find((phase) => phase === progressMatch?.[2]) ?? "unknown";
      cold.mark("tor.bootstrap.progress", {
        lane: this.traceLane, attempt: this.traceAttempt, progress: this.bootstrapProgress,
        elapsedMs: this.traceLastProgressAt - this.traceStartedAt,
        lastProgressMs: this.traceLastProgressAt - this.traceStartedAt,
        phase: this.tracePhase,
        mode: this.traceMode,
      });
    }
  }

  private resolveBundleRoot(torPath: string) {
    const candidate = path.dirname(path.dirname(torPath));
    const defaultsPath = path.join(candidate, "data", "torrc-defaults");

    return fs.existsSync(defaultsPath) ? candidate : undefined;
  }

  private async traceCache(attempt: number) {
    if (process.env.NKC_COLD_START_TRACE !== "1") return;
    const directory = this.dataDir;
    const files = ["cached-microdesc-consensus", "cached-microdescs", "cached-microdescs.new", "cached-certs", "cached-consensus", "cached-descriptors"];
    const stats = await Promise.all(files.map((name) => fsPromises.stat(path.join(directory, name)).catch(() => null)));
    cold.mark("tor.cache.snapshot", { lane: this.traceLane, attempt,
      cacheFiles: stats.filter((stat) => stat?.isFile()).length,
      cacheBytes: stats.reduce((bytes, stat) => bytes + (stat?.isFile() ? stat.size : 0), 0) });
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

  private async repairMacCodeSignature(torPath: string) {
    if (process.platform !== "darwin") return;
    const torDir = path.dirname(torPath);

    const candidates = [
      path.join(torDir, "libevent-2.1.7.dylib"),
      path.join(torDir, "pluggable_transports", "conjure-client"),
      path.join(torDir, "pluggable_transports", "lyrebird"),
      torPath,
    ].filter((candidate) => fs.existsSync(candidate));

    for (const candidate of candidates) {
      await new Promise<void>((resolve, reject) => {
        execFile("/usr/bin/codesign", ["--force", "--sign", "-", candidate], (error, _stdout, stderr) => {
          if (!error) {
            resolve();

            return;
          }

          reject(
            new Error(
              `codesign failed for ${path.basename(candidate)}: ${stderr?.trim() || error.message}`
            )
          );
        });
      });
    }

    await this.clearMacQuarantine(path.dirname(torDir));
  }

  private resolveMacSystemTorPath(currentPath: string) {
    if (process.platform !== "darwin") return null;

    const candidates = [
      findInPath("tor"),
      "/opt/homebrew/bin/tor",
      "/usr/local/bin/tor",
      "/opt/local/bin/tor",
      "/usr/bin/tor",
    ].filter((candidate): candidate is string => Boolean(candidate));

    return candidates.find(
      (candidate) =>
        fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(currentPath)
    ) ?? null;
  }

  private resolveCountryCode() {
    const envCountry = process.env[TOR_COUNTRY_ENV];

    if (envCountry && /^[A-Za-z]{2}$/.test(envCountry.trim())) {
      return envCountry.trim().toUpperCase();
    }

    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      const localeCtor = Intl.Locale;

      if (localeCtor) {
        const region = new localeCtor(locale).region;

        if (region && /^[A-Z]{2}$/.test(region)) return region;
      }

      const match = locale.match(/[-_]([A-Za-z]{2})(?:[-_]|$)/);

      if (match) return match[1].toUpperCase();
    } catch {
      // ignore locale parse failure
    }

    return "ZZ";
  }

  private resolveLyrebirdPath(torPath: string) {
    const basename = process.platform === "win32" ? "lyrebird.exe" : "lyrebird";
    const torDir = path.dirname(torPath);

    const candidates = [
      path.join(torDir, basename),
      path.join(torDir, "pluggable_transports", basename),
      path.join(path.dirname(torDir), "pluggable_transports", basename),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  private buildTorrc(
    socksPort: number,
    torPath: string,
    hsConfig?: HiddenServiceConfig | null,
    bridgeMode = this.bridgeModeOverride ?? process.env[TOR_BRIDGES_ENV]
  ) {
    const lines = [
      `DataDirectory ${this.dataDir}`,
      `SocksPort 127.0.0.1:${socksPort}`,
      "SafeSocks 1",
      "DormantCanceledByStartup 1",
    ];

    // Disposable E2E profiles only: Tor's own onion-service (rend) log, addresses scrubbed by default SafeLogging.
    if (process.env.NKC_E2E_USER_DATA_DIR && process.env.NKC_TEST_TOR_REND_LOG === "1") {
      lines.push("Log notice stdout", `Log [rend]info file ${path.join(this.dataDir, "tor-rend.log")}`);
    }

    const bridgeSelection = resolveBridgeSelection({
      countryCode: this.resolveCountryCode(),
      mode: bridgeMode,
    });

    this.bridgeDetail = null;

    if (bridgeSelection.enabled) {
      const lyrebirdPath = this.resolveLyrebirdPath(torPath);
      let bridgeLines = [...bridgeSelection.lines];

      if (bridgeSelection.requiresLyrebird && !lyrebirdPath) {
        bridgeLines = bridgeLines.filter((line) => !needsLyrebird(line));
        this.bridgeDetail = `bridges-enabled-without-lyrebird(mode=${bridgeSelection.mode}, country=${bridgeSelection.countryCode})`;
      }

      if (bridgeLines.length > 0) {
        lines.push("UseBridges 1");

        if (bridgeLines.some((line) => needsLyrebird(line)) && lyrebirdPath) {
          const bundleRoot = this.resolveBundleRoot(torPath);

          const transportPath = bundleRoot
            ? `./${path.relative(bundleRoot, lyrebirdPath).split(path.sep).join("/")}`
            : lyrebirdPath;

          lines.push(`ClientTransportPlugin obfs4 exec ${transportPath}`);
          lines.push(`ClientTransportPlugin meek_lite exec ${transportPath}`);
          lines.push(`ClientTransportPlugin snowflake exec ${transportPath}`);
        }

        lines.push(...bridgeLines);

        if (!this.bridgeDetail) {
          this.bridgeDetail = `bridges-enabled(mode=${bridgeSelection.mode}, country=${bridgeSelection.countryCode}, count=${bridgeLines.length})`;
        }
      } else {
        lines.push("UseBridges 0");
        this.bridgeDetail =
          `bridges-skipped-no-compatible-lines(mode=${bridgeSelection.mode}, country=${bridgeSelection.countryCode})`;
      }
    } else {
      lines.push("UseBridges 0");

      if (bridgeSelection.reason) {
        this.bridgeDetail = `bridges-disabled(reason=${bridgeSelection.reason}, mode=${bridgeSelection.mode}, country=${bridgeSelection.countryCode})`;
      }
    }

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

  private releaseReservedSocksPort(port = this.reservedSocksPort) {
    if (port === null || this.reservedSocksPort !== port) return;
    this.reservedSocksPort = null;
    releaseTorSocksPort(port);
  }

  async start(opts?: TorStartOptions) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startRequested(opts).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startRequested(opts?: TorStartOptions) {
    if (this.stopPromise) {
      await this.stopPromise;
    }

    if (opts?.bridgeMode && opts.bridgeMode !== this.bridgeModeOverride) {
      this.bridgeModeOverride = opts.bridgeMode;

      if (this.process) await this.stop();
    }

    // A spawned process may still be bootstrapping. Join its startup before
    // considering the already-running fast path.
    if (this.process) return;
    const mode = this.bridgeModeOverride ?? process.env[TOR_BRIDGES_ENV]?.trim().toLowerCase();

    const attempt: TorAttempt = {
      mode: mode === "off" || mode === "auto" || mode === "force" ? mode : undefined,
      bridgeFallbackUsed: false,
    };

    await this.startInternal(opts, attempt);
  }

  private async startInternal(opts?: TorStartOptions, attempt?: TorAttempt) {
    if (this.process) return;
    const trace = { lane: this.traceLane, attempt: ++this.traceAttempt };
    const startedAt = performance.now();
    this.traceStartedAt = startedAt;
    this.traceLastProgressAt = 0;
    this.tracePhase = "unknown";
    const endStart = cold.begin("tor.start.begin", { ...trace, hsConfigured: Boolean(this.hsConfig) });

    try {
      const endBinary = cold.begin("tor.binary.begin", trace);
      const torPath = await this.resolveTorPath();
      endBinary("tor.binary.end", torPath ? "ok" : "unavailable");

      if (!torPath) {
        cold.mark("tor.attempt.summary", { ...trace, reason: "binary_missing", outcome: "unavailable", elapsedMs: performance.now() - startedAt });
        this.lifecycle.setWrapperState("stopped");
        this.emit({ state: "unavailable", details: "tor-binary-not-found" });

        return;
      }

      this.dataDir = this.resolveDataDir(opts);
      void this.traceCache(trace.attempt);
      this.logTail = "";
      this.bootstrapProgress = 0;
      this.lifecycle.setReasonsDisabled(0);
      this.lifecycle.setWrapperState("starting");
      this.emit({ state: "starting", details: "starting-tor" });
      await fsPromises.mkdir(this.dataDir, { recursive: true });
      const socksPort = await reserveTorSocksPort();
      this.reservedSocksPort = socksPort;

      try {
        const torrcPath = path.join(this.dataDir, "torrc");
        const traceHsConfigured = Boolean(this.hsConfig);
        cold.mark("tor.config.begin", trace);
        const torrc = this.buildTorrc(socksPort, torPath, this.hsConfig, attempt?.mode);
        this.traceMode = /^UseBridges 1$/m.test(torrc) ? "bridged" : "direct";
        await fsPromises.writeFile(torrcPath, torrc, "utf8");
        cold.mark("tor.config.written", {
          ...trace, hsConfigured: traceHsConfigured,
          mode: this.traceMode,
          policyMode: (["off", "auto", "force"] as const).find((value) => this.bridgeDetail?.includes(`mode=${value}`)),
        });

        if (attempt?.mode === "force" && this.traceMode !== "bridged") {
          this.releaseReservedSocksPort(socksPort);
          this.lifecycle.setWrapperState("stopped");
          cold.mark("tor.attempt.summary", { ...trace, mode: "direct", reason: "bridge_unavailable", outcome: "failed" });
          this.emit({ state: "failed", details: "bridges-unavailable" });

          return;
        }

        await this.ensureExecutable(torPath);
        await this.clearMacQuarantine(torPath);

        if (!this.isStartingStatus()) {
          this.releaseReservedSocksPort(socksPort);

          return;
        }

        this.expectProcessExit = false;
        cold.mark("tor.process.spawn.begin", { ...trace, hsConfigured: traceHsConfigured });
        this.process = spawn(torPath, ["-f", torrcPath], {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: this.resolveBundleRoot(torPath),
        });
      } catch (error) {
        this.releaseReservedSocksPort(socksPort);
        throw error;
      }

      this.process.once("spawn", () => cold.mark("tor.process.spawned", trace));
      this.process.stdout?.on("data", (chunk) => this.appendLog(chunk));
      this.process.stderr?.on("data", (chunk) => this.appendLog(chunk));
      let processFailure: "spawn_error" | "process_exit" | undefined;
      this.process.once("error", (error) => {
        processFailure = "spawn_error";
        cold.mark("tor.process.error", { ...trace, reason: "spawn_error", elapsedMs: performance.now() - startedAt });
        const detail = error instanceof Error ? error.message : String(error);
        this.process = null;
        this.expectProcessExit = false;
        this.releaseReservedSocksPort(socksPort);
        this.lifecycle.setWrapperState("stopped");
        this.emit({ state: "failed", details: `tor-spawn-failed: ${detail}` });
      });
      this.process.once("exit", (code, signal) => {
        const expectedExit = this.expectProcessExit;

        if (!expectedExit) processFailure = "process_exit";
        cold.mark("tor.process.exit", {
          ...trace, expectedExit, exitCode: code ?? undefined, reason: expectedExit ? undefined : "process_exit",
          elapsedMs: performance.now() - startedAt,
        });
        this.process = null;
        this.expectProcessExit = false;
        this.releaseReservedSocksPort(socksPort);

        if (expectedExit) return;
        const tail = this.logTail ? ` | ${this.logTail}` : "";
        this.lifecycle.setWrapperState("stopped");
        this.emit({
          state: "failed",
          details: `tor-exited(code=${code ?? "null"},signal=${signal ?? "none"})${tail}`,
        });
      });
      this.lifecycle.setWrapperState("connecting");

      const bootstrapTimeoutMs = this.traceMode === "bridged"
        ? BRIDGE_START_TIMEOUT_MS
        : START_TIMEOUT_MS;

      const mode = this.traceMode;
      let socksObserved: boolean | undefined;
      const endSocks = cold.begin("tor.socks_check.begin", { ...trace, mode });
      const endBootstrap = cold.begin("tor.bootstrap_check.begin", { ...trace, mode });

      const [portReady, bootstrapReady] = await Promise.all([
        waitForPort(socksPort, START_TIMEOUT_MS, () => !this.isStartingStatus()).then((ready) => {
          socksObserved = ready;
          endSocks("tor.socks_check.end", ready ? "ok" : "failed");

          return ready;
        }),
        waitForBootstrap(
          () => this.bootstrapProgress,
          bootstrapTimeoutMs,
          () => !this.isStartingStatus(),
          bootstrapTimeoutMs === START_TIMEOUT_MS ? 30_000 : 0
        ).then((ready) => {
          endBootstrap("tor.bootstrap_check.end", ready ? "ok" : "failed");
          const now = performance.now();
          cold.mark("tor.attempt.summary", {
            ...trace, mode, progress: this.bootstrapProgress, elapsedMs: now - startedAt,
            lastProgressMs: this.traceLastProgressAt ? this.traceLastProgressAt - startedAt : undefined,
            stallMs: now - (this.traceLastProgressAt || startedAt), phase: this.tracePhase,
            socksReady: socksObserved, bootstrapReady: ready, processRunning: Boolean(this.process),
            outcome: ready ? "ok" : "failed",
            reason: ready ? undefined : this.status.state === "failed"
              ? this.isDataDirConflict(this.status.details) ? "data_dir_conflict" : processFailure
              : !this.isStartingStatus() ? "cancelled" : "bootstrap_timeout",
          });

          return ready;
        }),
      ]);

      if (!portReady || !bootstrapReady) {
        const failedDetails = this.status.state === "failed" ? this.status.details : "";
        const macKilled = process.platform === "darwin" && failedDetails.includes("signal=SIGKILL");

        if (macKilled && !this.macSignatureRepairAttempted) {
          cold.mark("tor.retry", { ...trace, mode, reason: "mac_signature_repair" });
          this.macSignatureRepairAttempted = true;

          try {
            await this.repairMacCodeSignature(torPath);
            endStart("tor.start.end", "failed");
            await this.startInternal(opts, attempt);

            return;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.emit({ state: "failed", details: `[MACOS_TOR_BLOCKED] ${detail}` });
          }
        }

        if (macKilled && !this.macSystemTorFallbackAttempted) {
          this.macSystemTorFallbackAttempted = true;
          const systemTorPath = this.resolveMacSystemTorPath(torPath);

          if (systemTorPath) {
            cold.mark("tor.retry", { ...trace, mode, reason: "system_tor_fallback" });
            this.torPath = systemTorPath;
            endStart("tor.start.end", "failed");
            await this.startInternal(opts, attempt);

            return;
          }
        }

        if (macKilled) {
          this.emit({
            state: "failed",
            details: `[MACOS_TOR_BLOCKED] bundled Tor exited with SIGKILL and no working system Tor was found | ${failedDetails}`,
          });

          return;
        }

        if (this.status.state === "failed" && this.isDataDirConflict(this.status.details)) {
          return;
        }

        if (this.status.state === "failed") {
          return;
        }

        if (!this.isStartingStatus()) {
          return;
        }

        const failedProgress = this.bootstrapProgress;
        const failedLogTail = this.logTail;

        const shouldRetryWithBridges =
          portReady &&
          !bootstrapReady &&
          mode === "direct" &&
          !attempt?.bridgeFallbackUsed &&
          attempt?.mode !== "off" && attempt?.mode !== "force";

        await this.stop();

        if (shouldRetryWithBridges) {
          const selection = resolveBridgeSelection({ countryCode: this.resolveCountryCode(), mode: "force" });
          const usable = selection.lines.some((line) => !needsLyrebird(line) || Boolean(this.resolveLyrebirdPath(torPath)));

          if (!usable) {
            cold.mark("tor.retry", { ...trace, mode, reason: "bridge_unavailable", outcome: "unavailable" });
            this.emit({ state: "failed", details: "bridges-unavailable-after-direct-timeout" });

            return;
          }

          cold.mark("tor.retry", { ...trace, mode, policyMode: "force", reason: "bridge_fallback" });
          endStart("tor.start.end", "failed");
          await this.startInternal(opts, { mode: "force", bridgeFallbackUsed: true });

          return;
        }

        const diagnosticTail = failedLogTail ? ` | ${failedLogTail}` : "";
        this.emit({
          state: "failed",
          details: portReady
            ? `bootstrap-not-ready:${failedProgress}%${diagnosticTail}`
            : `socks-not-ready${diagnosticTail}`,
        });

        return;
      }

      this.lifecycle.setWrapperState("connected");
      this.emit({
        state: "running",
        socksProxyUrl: `socks5://127.0.0.1:${socksPort}`,
        dataDir: this.dataDir,
        details: this.bridgeDetail ?? undefined,
      });
    } finally {
      endStart("tor.start.end", this.status.state === "running" ? "ok" : "failed");
    }
  }

  async restart() {
    const profileScopedDataDir = this.dataDir !== this.baseDataDir;
    await this.stop();
    await this.start({ profileScopedDataDir });
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
      this.releaseReservedSocksPort();
      this.expectProcessExit = false;
      this.lifecycle.setWrapperState("stopped");
      this.emit({ state: "unavailable", details: "stopped" });

      return;
    }

    this.expectProcessExit = true;
    this.lifecycle.setWrapperState("stopping");
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
    this.releaseReservedSocksPort();
    this.lifecycle.setWrapperState("stopped");
    this.emit({ state: "unavailable", details: "stopped" });
  }

  getStatus() {
    return this.status;
  }

  invalidateResolvedPath() {
    this.torPath = null;
    this.macSignatureRepairAttempted = false;
    this.macSystemTorFallbackAttempted = false;
  }

  getDiagnostics(): TorDiagnostics {
    return {
      state: this.status.state,
      bootstrapProgress: this.bootstrapProgress,
      processRunning: Boolean(this.process),
      bridgeMode: this.bridgeDetail?.startsWith("bridges-enabled") ? "bridged" : "direct",
      pluginState: this.lifecycle.getState(),
      reasonsDisabled: this.lifecycle.getReasonsDisabled(),
    };
  }

  configureHiddenService(opts: { localPort: number; virtPort: number }) {
    if (this.process) {
      const unchanged =
        this.hsConfig?.localPort === opts.localPort && this.hsConfig?.virtPort === opts.virtPort;

      if (!unchanged) throw new Error("tor-hidden-service-already-running");

      return;
    }

    this.hsConfig = { ...opts };
    cold.mark("hidden_service.configured", { lane: this.traceLane });
  }

  async ensureHiddenService(opts: { localPort: number; virtPort: number }) {
    if (this.ensureHiddenServicePromise) return this.ensureHiddenServicePromise;
    this.ensureHiddenServicePromise = this.ensureHiddenServiceInternal(opts).finally(() => {
      this.ensureHiddenServicePromise = null;
    });

    return this.ensureHiddenServicePromise;
  }

  private async ensureHiddenServiceInternal(opts: { localPort: number; virtPort: number }) {
    const end = cold.begin("tor.hidden_service.ensure.begin", { lane: this.traceLane });

    try {
      const hsChanged =
        !this.hsConfig ||
        this.hsConfig.localPort !== opts.localPort ||
        this.hsConfig.virtPort !== opts.virtPort;

      this.hsConfig = opts;

      if (hsChanged && this.process) {
        await this.stop();
      }

      await this.start();

      if (this.status.state !== "running" && this.isDataDirConflict(this.status.details)) {
      cold.mark("tor.retry", { lane: this.traceLane, attempt: this.traceAttempt, reason: "data_dir_conflict" });
        await this.start({ profileScopedDataDir: true });
      }

      if (this.status.state !== "running") {
        throw new Error(this.status.state === "failed" ? this.status.details : "tor-unavailable");
      }

      const hsDir = path.join(this.dataDir, "hs-onion");
      const hostnamePath = path.join(hsDir, "hostname");
      cold.mark("tor.hostname.begin", { lane: this.traceLane });
      const onionHost = await waitForHostname(hostnamePath, HOSTNAME_TIMEOUT_MS);
      cold.mark("tor.hostname.available", { lane: this.traceLane });
      end("tor.hidden_service.ensure.end", "ok");

      return { onionHost };
    } catch (error) {
      end("tor.hidden_service.ensure.end", "failed");
      throw error;
    }
  }

  onStatus(cb: (s: TorStatus) => void) {
    this.listeners.add(cb);
    cb(this.status);

    return () => {
      this.listeners.delete(cb);
    };
  }
}
