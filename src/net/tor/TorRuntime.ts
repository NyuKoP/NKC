import { checkSocksProxyReachable } from "./torProxyHealth";

export type TorState = "STOPPED" | "STARTING" | "BOOTSTRAPPING" | "READY" | "DEGRADED" | "STOPPING";

type TorStatusSnapshot = {
  state: string;
  socksUrl: string | null;
  dataDir: string | null;
  details: string | null;
};

type TorStartOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  profileScopedDataDir?: boolean;
};

type TorBridge = {
  getTorStatus?: () => Promise<unknown>;
  startTor?: (opts?: { profileScopedDataDir?: boolean }) => Promise<unknown>;
  stopTor?: () => Promise<unknown>;
  setOnionForwardProxy?: (proxyUrl: string | null) => Promise<unknown>;
};

type TorRuntimeDeps = {
  getBridge: () => TorBridge | null;
  checkProxyReachable: (socksUrl: string, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (level: "info" | "warn", message: string, context?: Record<string, unknown>) => void;
};

type CodedError = Error & { code: string };

const START_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 220;

const toPositiveMs = (value: number | undefined, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value as number));
};

const toStringOrNull = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseStatus = (raw: unknown): TorStatusSnapshot => {
  if (!raw || typeof raw !== "object") {
    return { state: "unavailable", socksUrl: null, dataDir: null, details: null };
  }
  const value = raw as {
    state?: unknown;
    socksProxyUrl?: unknown;
    dataDir?: unknown;
    details?: unknown;
    error?: unknown;
  };
  return {
    state: toStringOrNull(value.state) ?? "unavailable",
    socksUrl: toStringOrNull(value.socksProxyUrl),
    dataDir: toStringOrNull(value.dataDir),
    details: toStringOrNull(value.details) ?? toStringOrNull(value.error),
  };
};

const includesDataDirConflict = (details: string | null) =>
  Boolean(details && details.toLowerCase().includes("another tor process is running with the same data directory"));

const getPortFromUrl = (url: string | null) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : null;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
};

const createDefaultDeps = (): TorRuntimeDeps => ({
  getBridge: () =>
    (
      globalThis as {
        nkc?: TorBridge;
      }
    ).nkc ?? null,
  checkProxyReachable: checkSocksProxyReachable,
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
  log: (level, message, context) => {
    if (level === "warn") {
      if (context) console.warn("[tor-runtime]", message, context);
      else console.warn("[tor-runtime]", message);
      return;
    }
    if (context) console.info("[tor-runtime]", message, context);
    else console.info("[tor-runtime]", message);
  },
});

export class TorRuntime {
  private static singleton: TorRuntime | null = null;

  static getInstance() {
    if (!TorRuntime.singleton) {
      TorRuntime.singleton = new TorRuntime();
    }
    return TorRuntime.singleton;
  }

  static __resetForTests() {
    TorRuntime.singleton = null;
  }

  private readonly deps: TorRuntimeDeps;
  private state: TorState = "STOPPED";
  private socksUrl: string | null = null;
  private dataDir: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(deps?: Partial<TorRuntimeDeps>) {
    const defaults = createDefaultDeps();
    this.deps = {
      getBridge: deps?.getBridge ?? defaults.getBridge,
      checkProxyReachable: deps?.checkProxyReachable ?? defaults.checkProxyReachable,
      sleep: deps?.sleep ?? defaults.sleep,
      now: deps?.now ?? defaults.now,
      log: deps?.log ?? defaults.log,
    };
  }

  getState() {
    return this.state;
  }

  getSocksUrl() {
    return this.socksUrl;
  }

  getDataDir() {
    return this.dataDir;
  }

  markDegraded(reason: string, err?: unknown) {
    const detail = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
    this.transition("DEGRADED", {
      reason,
      detail,
    });
  }

  async start(opts: TorStartOptions = {}) {
    if (this.state === "READY") return;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) {
      await this.stopPromise;
    }
    this.startPromise = this.startInternal(opts).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop() {
    if (this.state === "STOPPED" && !this.stopPromise) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async awaitReady(timeoutMs: number, signal?: AbortSignal) {
    const timeout = toPositiveMs(timeoutMs, START_TIMEOUT_MS);
    const startedAt = this.deps.now();
    if (this.state !== "READY") {
      try {
        await this.start({ timeoutMs: timeout, signal });
      } catch {
        // Await loop below converts any startup failure to TOR_NOT_READY.
      }
    }
    while (this.deps.now() - startedAt < timeout) {
      if (signal?.aborted) throw this.codedError("TOR_NOT_READY", "TOR_NOT_READY: aborted");
      if (this.state === "READY") return;
      if (this.state === "DEGRADED") {
        throw this.codedError("TOR_NOT_READY", "TOR_NOT_READY: runtime degraded");
      }
      await this.deps.sleep(80);
    }
    throw this.codedError("TOR_NOT_READY", "TOR_NOT_READY: timed out waiting for Tor READY");
  }

  private async startInternal(opts: TorStartOptions) {
    const timeoutMs = toPositiveMs(opts.timeoutMs, START_TIMEOUT_MS);
    const bridge = this.deps.getBridge();
    if (!bridge?.getTorStatus || !bridge.startTor) {
      this.markDegraded("bridge_unavailable");
      throw this.codedError("TOR_NOT_READY", "TOR runtime bridge unavailable");
    }
    this.transition("STARTING");
    const existing = await this.fetchStatus(bridge);
    if (await this.adoptIfHealthy(existing, timeoutMs, opts.signal, bridge)) {
      return;
    }

    await bridge.startTor({
      profileScopedDataDir: opts.profileScopedDataDir === true,
    });
    this.transition("BOOTSTRAPPING");

    const firstWait = await this.waitForReady(timeoutMs, opts.signal, bridge);
    if (firstWait.ready) {
      return;
    }
    if (!firstWait.dataDirConflict || opts.profileScopedDataDir) {
      this.markDegraded("startup_timeout", firstWait.details ?? undefined);
      throw this.codedError("TOR_NOT_READY", "Tor runtime did not become READY in time");
    }

    this.deps.log("warn", "tor data directory conflict detected; retrying with profile-scoped DataDirectory");
    await bridge.startTor({
      profileScopedDataDir: true,
    });
    this.transition("BOOTSTRAPPING");
    const secondWait = await this.waitForReady(timeoutMs, opts.signal, bridge);
    if (secondWait.ready) {
      return;
    }
    this.markDegraded("data_directory_conflict", secondWait.details ?? firstWait.details ?? undefined);
    throw this.codedError("TOR_NOT_READY", "Tor runtime degraded due to DataDirectory conflict");
  }

  private async stopInternal() {
    const bridge = this.deps.getBridge();
    this.transition("STOPPING");
    if (bridge?.stopTor) {
      try {
        await bridge.stopTor();
      } catch (error) {
        this.deps.log("warn", "stopTor failed", {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (bridge?.setOnionForwardProxy) {
      try {
        await bridge.setOnionForwardProxy(null);
      } catch {
        // best effort
      }
    }
    this.socksUrl = null;
    this.dataDir = null;
    this.transition("STOPPED");
  }

  private async fetchStatus(bridge: TorBridge) {
    try {
      return parseStatus(await bridge.getTorStatus?.());
    } catch (error) {
      this.deps.log("warn", "getTorStatus failed", {
        detail: error instanceof Error ? error.message : String(error),
      });
      return { state: "failed", socksUrl: null, dataDir: null, details: "status-query-failed" } satisfies TorStatusSnapshot;
    }
  }

  private async waitForReady(timeoutMs: number, signal: AbortSignal | undefined, bridge: TorBridge) {
    const startedAt = this.deps.now();
    let conflictDetails: string | null = null;
    while (this.deps.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        return { ready: false as const, dataDirConflict: false, details: "aborted" };
      }
      const status = await this.fetchStatus(bridge);
      if (await this.adoptIfHealthy(status, timeoutMs, signal, bridge)) {
        return { ready: true as const, dataDirConflict: false, details: null };
      }
      if (includesDataDirConflict(status.details)) {
        conflictDetails = status.details;
      }
      await this.deps.sleep(READY_POLL_INTERVAL_MS);
    }
    return {
      ready: false as const,
      dataDirConflict: Boolean(conflictDetails),
      details: conflictDetails,
    };
  }

  private async adoptIfHealthy(
    status: TorStatusSnapshot,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    bridge: TorBridge
  ) {
    if (status.state !== "running" || !status.socksUrl) return false;
    const reachable = await this.deps.checkProxyReachable(status.socksUrl, Math.min(timeoutMs, 3000), signal);
    if (!reachable) return false;
    this.socksUrl = status.socksUrl;
    this.dataDir = status.dataDir;
    if (bridge.setOnionForwardProxy) {
      try {
        await bridge.setOnionForwardProxy(status.socksUrl);
      } catch {
        // best effort
      }
    }
    this.transition("READY", {
      dataDir: this.dataDir,
      socksPort: getPortFromUrl(this.socksUrl),
    });
    return true;
  }

  private transition(next: TorState, context?: Record<string, unknown>) {
    if (this.state === next) return;
    this.state = next;
    this.deps.log("info", `state -> ${next}`, context);
  }

  private codedError(code: string, message: string) {
    const err = new Error(message) as CodedError;
    err.code = code;
    return err;
  }
}
