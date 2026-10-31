import { countSessionStage } from "../../diagnostics/sessionInvestigation";
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
  bridgeMode?: "off" | "auto" | "force";
};

type TorBridge = {
  getTorStatus?: () => Promise<unknown>;
  startTor?: (opts?: {
    profileScopedDataDir?: boolean;
    bridgeMode?: "off" | "auto" | "force";
  }) => Promise<unknown>;
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


const START_TIMEOUT_MS = 15_000;

const READY_POLL_INTERVAL_MS = 220;

const READY_STATUS_RECHECK_MS = 5_000;

const toPositiveMs = (value: number | undefined, fallback: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;

  return Math.max(1, Math.round(value));
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

  return {
    state: toStringOrNull("state" in raw ? raw.state : undefined) ?? "unavailable",
    socksUrl: toStringOrNull("socksProxyUrl" in raw ? raw.socksProxyUrl : undefined),
    dataDir: toStringOrNull("dataDir" in raw ? raw.dataDir : undefined),
    details: toStringOrNull("details" in raw ? raw.details : undefined) ?? toStringOrNull("error" in raw ? raw.error : undefined),
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
  private bridgeStartPromise: Promise<unknown> | null = null;
  private stopPromise: Promise<void> | null = null;
  private recoverPromise: Promise<void> | null = null;
  private lastReadyStatusCheckAt = 0;
  private stopGeneration = 0;

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

    if (this.startPromise) {
      countSessionStage("tor-start-join", "input");

      return this.waitForSharedStart(this.startPromise, opts);
    }

    if (this.stopPromise) {
      await this.stopPromise;

      if (this.startPromise) return this.waitForSharedStart(this.startPromise, opts);
    }

    this.startPromise = (async () => {
      let generation = this.stopGeneration;

      if (this.state === "READY") {
        const checkedAt = this.deps.now();

        if (checkedAt - this.lastReadyStatusCheckAt < READY_STATUS_RECHECK_MS) return;
        const bridge = this.deps.getBridge();

        if (bridge?.getTorStatus) {
          try {
            const status = await this.fetchStatus(bridge);
            this.assertNotStopped(generation);

            if (await this.adoptIfHealthy(status, opts.timeoutMs ?? START_TIMEOUT_MS, opts.signal, bridge, generation)) return;
            this.markDegraded("runtime_process_unavailable", status.details ?? status.state);

            if (status.state === "running") {
              await this.stop();
              generation = this.stopGeneration;
            }
          } catch (error) {
            if (generation === this.stopGeneration) this.markDegraded("runtime_health_check_failed");
            throw error;
          }
        }
      }

      this.assertNotStopped(generation);
      await this.startInternal(opts, generation);
    })().finally(() => {
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

  private async waitForSharedStart(pending: Promise<void>, opts: TorStartOptions) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      if (opts.signal?.aborted) throw this.codedError("TOR_START_ABORTED", "Tor start waiter aborted");

      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(this.codedError("TOR_START_TIMEOUT", "Tor start waiter exceeded its deadline")),
          toPositiveMs(opts.timeoutMs, START_TIMEOUT_MS));
        onAbort = () => reject(this.codedError("TOR_START_ABORTED", "Tor start waiter aborted"));
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      });
      // A joining waiter's deadline must not cancel the shared bootstrap or its other callers.

      await Promise.race([pending, deadline]);
    } finally {
      if (timer) clearTimeout(timer);

      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async recover(opts: TorStartOptions = {}) {
    if (this.recoverPromise) return this.waitForSharedStart(this.recoverPromise, opts);
    this.recoverPromise = (async () => {
      this.markDegraded("proxy_recovery");
      await this.stop();
      await this.start(opts);
    })().finally(() => {
      this.recoverPromise = null;
    });

    return this.recoverPromise;
  }

  async awaitReady(timeoutMs: number, signal?: AbortSignal) {
    const timeout = toPositiveMs(timeoutMs, START_TIMEOUT_MS);
    const startedAt = this.deps.now();

    if (signal?.aborted) throw this.codedError("TOR_NOT_READY", "TOR_NOT_READY: aborted");

    // READY is cached, not proof that the managed process is still reachable.
    // start() coalesces callers and revalidates snapshots older than five seconds.
    try {
      await this.start({ timeoutMs: timeout, signal });
    } catch {
      // Await loop below converts any startup failure to TOR_NOT_READY.
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

  private async startInternal(opts: TorStartOptions, generation: number) {
    const timeoutMs = toPositiveMs(opts.timeoutMs, START_TIMEOUT_MS);
    const bridge = this.deps.getBridge();

    if (!bridge?.getTorStatus || !bridge.startTor) {
      this.markDegraded("bridge_unavailable");
      throw this.codedError("TOR_NOT_READY", "TOR runtime bridge unavailable");
    }

    this.transition("STARTING");
    const existing = await this.fetchStatus(bridge);
    this.assertNotStopped(generation);

    if (await this.adoptIfHealthy(existing, timeoutMs, opts.signal, bridge, generation)) {
      return;
    }

    await this.startBridgeWithDeadline(bridge, opts, timeoutMs, generation);
    this.assertNotStopped(generation);
    this.transition("BOOTSTRAPPING");

    const firstWait = await this.waitForReady(timeoutMs, opts.signal, bridge, generation);
    this.assertNotStopped(generation);

    if (firstWait.ready) {
      return;
    }

    if (!firstWait.dataDirConflict || opts.profileScopedDataDir) {
      this.markDegraded("startup_timeout", firstWait.details ?? undefined);
      throw this.codedError("TOR_NOT_READY", "Tor runtime did not become READY in time");
    }

    this.deps.log("warn", "tor data directory conflict detected; retrying with profile-scoped DataDirectory");
    await this.startBridgeWithDeadline(
      bridge,
      { ...opts, profileScopedDataDir: true },
      timeoutMs,
      generation
    );
    this.assertNotStopped(generation);
    this.transition("BOOTSTRAPPING");
    const secondWait = await this.waitForReady(timeoutMs, opts.signal, bridge, generation);
    this.assertNotStopped(generation);

    if (secondWait.ready) {
      return;
    }

    this.markDegraded("data_directory_conflict", secondWait.details ?? firstWait.details ?? undefined);
    throw this.codedError("TOR_NOT_READY", "Tor runtime degraded due to DataDirectory conflict");
  }

  private async startBridgeWithDeadline(
    bridge: TorBridge,
    opts: TorStartOptions,
    timeoutMs: number,
    generation: number
  ) {
    if (!bridge.startTor) {
      throw this.codedError("TOR_NOT_READY", "Tor runtime bridge unavailable");
    }

    if (opts.signal?.aborted) {
      const error = this.codedError("TOR_START_ABORTED", "Tor start was aborted");
      this.markDegraded("startup_aborted", error);
      throw error;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(this.codedError("TOR_START_TIMEOUT", "Tor start IPC exceeded its deadline"));
      }, timeoutMs);

      if (opts.signal) {
        abortHandler = () => {
          reject(this.codedError("TOR_START_ABORTED", "Tor start was aborted"));
        };

        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    try {
      // A caller's deadline does not cancel Electron's start IPC. Reuse it
      // until it settles instead of launching overlapping starts.
      if (!this.bridgeStartPromise) {
        const pending = Promise.resolve().then(() => bridge.startTor!({
          profileScopedDataDir: opts.profileScopedDataDir === true,
          bridgeMode: opts.bridgeMode,
        }));

        this.bridgeStartPromise = pending;
        void pending.finally(() => {
          if (this.bridgeStartPromise === pending) this.bridgeStartPromise = null;
        }).catch(() => {});
      }

      await Promise.race([
        this.bridgeStartPromise,
        deadline,
      ]);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code ?? "")
        : "";

      if (generation === this.stopGeneration && (code === "TOR_START_TIMEOUT" || code === "TOR_START_ABORTED")) {
        this.markDegraded(code === "TOR_START_TIMEOUT" ? "startup_timeout" : "startup_aborted", error);
      }

      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private async stopInternal() {
    this.stopGeneration++;
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
      countSessionStage("tor-status", "input");
      const status = parseStatus(await bridge.getTorStatus?.());
      countSessionStage("tor-status", "success");

      return status;
    } catch (error) {
      this.deps.log("warn", "getTorStatus failed", {
        detail: error instanceof Error ? error.message : String(error),
      });

      return { state: "failed", socksUrl: null, dataDir: null, details: "status-query-failed" } satisfies TorStatusSnapshot;
    }
  }

  private async waitForReady(timeoutMs: number, signal: AbortSignal | undefined, bridge: TorBridge, generation: number) {
    const startedAt = this.deps.now();
    let conflictDetails: string | null = null;

    while (this.deps.now() - startedAt < timeoutMs) {
      this.assertNotStopped(generation);

      if (signal?.aborted) {
        return { ready: false as const, dataDirConflict: false, details: "aborted" };
      }

      const status = await this.fetchStatus(bridge);
      this.assertNotStopped(generation);

      if (await this.adoptIfHealthy(status, timeoutMs, signal, bridge, generation)) {
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
    bridge: TorBridge,
    generation: number
  ) {
    if (status.state !== "running" || !status.socksUrl) return false;
    countSessionStage("tor-proxy", "input");
    const reachable = await this.deps.checkProxyReachable(status.socksUrl, Math.min(timeoutMs, 3000), signal);
    this.assertNotStopped(generation);

    countSessionStage("tor-proxy", reachable ? "success" : "rejected");

    if (!reachable) return false;

    if (bridge.setOnionForwardProxy) {
      try {
        countSessionStage("tor-forward-proxy", "input");
        const result = await bridge.setOnionForwardProxy(status.socksUrl);
        countSessionStage("tor-forward-proxy", "success");

        if (result && typeof result === "object" &&
            (("ok" in result && result.ok === false) || ("success" in result && result.success === false))) {
          throw new Error("Controller rejected the forward proxy configuration");
        }
      } catch (error) {
        this.assertNotStopped(generation);
        this.markDegraded("forward_proxy_sync_failed", error);
        throw this.codedError("TOR_NOT_READY", "Tor forward proxy synchronization failed");
      }
    }

    this.assertNotStopped(generation);
    this.socksUrl = status.socksUrl;
    this.dataDir = status.dataDir;
    this.lastReadyStatusCheckAt = this.deps.now();
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

  private assertNotStopped(generation: number) {
    if (generation !== this.stopGeneration) {
      throw this.codedError("TOR_START_ABORTED", "Tor startup superseded by stop");
    }
  }

  private codedError(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }
}
