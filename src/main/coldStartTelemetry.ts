import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { torProbeErrorCodes, probeNetworkStages } from "./torProbeError";

export const bootstrapPhases = ["starting", "conn", "conn_done", "conn_pt", "conn_done_pt", "conn_proxy", "conn_done_proxy", "handshake", "handshake_done",
  "onehop_create", "requesting_status", "loading_status", "loading_keys", "requesting_descriptors",
  "loading_descriptors", "enough_dirinfo", "ap_conn", "ap_conn_done", "ap_handshake", "ap_handshake_done",
  "ap_conn_pt", "ap_conn_done_pt", "ap_conn_proxy", "ap_conn_done_proxy", "circuit_create", "done", "unknown"] as const;

const events = [
  "app.module_loaded", "app.when_ready", "app.shutdown.begin", "worker.integrity.begin", "worker.integrity.ok",
  "worker.start.begin", "worker.start.ok", "worker.start.failed", "queue.init.begin", "queue.init.ok",
  "controller.start.begin", "controller.listen.ready", "controller.start.ok", "controller.start.failed",
  "hidden_service.configured", "ui.create.begin", "ui.create.returned", "ui.renderer.loaded", "ui.ready_to_show",
  "tor.ipc_start.begin", "tor.ipc_start.end", "tor.set_mode_start.begin", "tor.set_mode_start.end",
  "tor.start.begin", "tor.start.end", "tor.config.written", "tor.process.spawn.begin", "tor.process.spawned",
  "tor.socks_check.begin", "tor.socks_check.end", "tor.bootstrap_check.begin", "tor.bootstrap_check.end",
  "tor.bootstrap.progress", "tor.running", "tor.start.failed", "tor.hidden_service.ensure.begin",
  "tor.hidden_service.ensure.end", "tor.hostname.begin", "tor.hostname.available",
  "prewarm.ipc.begin", "prewarm.ipc.end", "prewarm.network.begin", "prewarm.network.end",
  "p2p.first_forward.begin", "p2p.first_forward.result",
  "onion.init.begin", "onion.init.end", "tor.dependencies.begin", "tor.dependencies.end",
  "tor.binary.begin", "tor.binary.end", "tor.config.begin", "tor.attempt.summary", "tor.retry",
  "tor.process.exit", "tor.process.error", "prewarm.result", "prewarm.lane.begin", "prewarm.lane.end",
  "controller.health.received", "controller.ingest.received", "controller.ingest.result",
  "tor.cache.snapshot", "tor.bootstrap.problem",
  "p2p.user_send", "p2p.peer_received", "p2p.peer_stored", "p2p.authenticated_read", "p2p.transport_ack", "p2p.native_forwarded", "renderer.startup_step",
  "p2p.queue.enqueued", "p2p.queue.flush.begin", "p2p.queue.flush", "p2p.queue.retry_result",
  "p2p.friend_send", "p2p.delivery.stage",
] as const;

type Event = typeof events[number];

type Fields = {
  messageKind?: "chat" | "friend";
  deliveryStage?: "controller_received" | "controller_accepted" | "decoded" | "message_decoded" | "refresh_requested" | "state_updated" | "rendered" | "duplicate_rejected" | "decode_failed" | "verified" | "decrypted" | "stored" | "displayed" | "replay_rejected" | "failed";
  deliveryPath?: "direct" | "sync_response" | "relay" | "unknown";
  deliveryOccurrence?: "first" | "later";
  conversationOpen?: boolean;
  observedMs?: number;
  lane?: "primary" | "secondary";
  outcome?: "ok" | "failed" | "queued" | "unavailable";
  target?: "self" | "other";
  attempt?: number;
  span?: number;
  progress?: number;
  durationMs?: number;
  hsConfigured?: boolean;
  mode?: "direct" | "bridged";
  reason?: "bootstrap_timeout" | "socks_timeout" | "process_exit" | "spawn_error" | "cancelled"
    | "data_dir_conflict" | "mac_signature_repair" | "system_tor_fallback" | "bridge_fallback" | "bridge_unavailable" | "binary_missing";
  errorCategory?: "invalid_address" | "proxy_unavailable" | "backoff" | "proxy_changed" | "native_unavailable"
    | "connection_refused" | "proxy_error" | "socks_error" | "http_error" | "timeout" | "unknown";
  disposition?: "network" | "cache" | "in_flight" | "rejected";
  elapsedMs?: number;
  lastProgressMs?: number;
  stallMs?: number;
  socksReady?: boolean;
  bootstrapReady?: boolean;
  processRunning?: boolean;
  expectedExit?: boolean;
  proxyReady?: boolean;
  torRunning?: boolean;
  laneIndex?: number;
  httpStatus?: number;
  exitCode?: number;
  phase?: typeof bootstrapPhases[number];
  stage?: "worker" | "queue" | "controller" | "hidden_service";
  policyMode?: "off" | "auto" | "force";
  errorCode?: typeof torProbeErrorCodes[number];
  networkStage?: typeof probeNetworkStages[number];
  cacheFiles?: number;
  cacheBytes?: number;
  rendererMs?: number;
  initStage?: "verify_key" | "repair_text" | "list_profiles" | "restore_conversations";
  queueState?: "not_observed" | "flush_busy" | "pending" | "in_flight" | "failed" | "delivered" | "retry_started" | "proxy_unavailable";
  queueAgeMs?: number;
  dueInMs?: number;
  dueLatenessMs?: number;
  retryStartMs?: number;
  nextDueInMs?: number;
  socksDurationMs?: number;
  attemptDurationMs?: number;
  workerSlotsUsed?: number;
  priorAttempts?: number;
  priorNetworkMs?: number;
  socksStarted?: boolean;
  connectionReused?: boolean;
};

const allowedEvents = new Set<string>(events);

const noop: (event: Event, outcome?: Fields["outcome"], details?: Fields) => void = () => {};

/** Main-process monotonic clock only. Never accepts paths, errors, IDs or payloads as fields. */
export class ColdStartTelemetry {
  private enabled: boolean;
  private readonly origin = performance.now();
  private runId = "";
  private file: string | null = null;
  private buffer: string[] = [];
  private total = 0;
  private spanId = 0;
  private tail: Promise<void> = Promise.resolve();
  private scheduled = false;

  constructor(enabled = process.env.NKC_COLD_START_TRACE === "1") {
    this.enabled = enabled;

    if (enabled) {
      try { this.runId = randomUUID(); } catch { this.enabled = false; }
    }
  }

  configure(userData: string) {
    if (!this.enabled || this.file) return;

    try {
      const dir = path.join(userData, "diagnostics", "cold-start");
      this.file = path.join(dir, `${this.runId}.ndjson`);
      this.tail = Promise.resolve().then(async () => {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.writeFile(this.file!, "", { flag: "wx", mode: 0o600 });
      }).catch(() => this.disable());
      this.schedule();
    } catch { this.disable(); }
  }

  mark(event: Event, fields: Fields = {}) {
    if (!this.enabled || this.total >= 4096) return;

    try {
      if (!allowedEvents.has(event)) return;
      const safe: Fields = {};

      // Runtime allowlist as well as static typing; never serialize arbitrary caller properties.
      if (fields.lane === "primary" || fields.lane === "secondary") safe.lane = fields.lane;

      if (["ok", "failed", "queued", "unavailable"].includes(fields.outcome ?? "")) safe.outcome = fields.outcome;

      if (fields.target === "self" || fields.target === "other") safe.target = fields.target;

      if (fields.mode === "direct" || fields.mode === "bridged") safe.mode = fields.mode;

      if (fields.policyMode === "off" || fields.policyMode === "auto" || fields.policyMode === "force") safe.policyMode = fields.policyMode;

      if (torProbeErrorCodes.some((code) => code === fields.errorCode)) safe.errorCode = fields.errorCode;

      if (probeNetworkStages.some((stage) => stage === fields.networkStage)) safe.networkStage = fields.networkStage;

      if (["verify_key", "repair_text", "list_profiles", "restore_conversations"].includes(fields.initStage ?? "")) safe.initStage = fields.initStage;

      if (["not_observed", "flush_busy", "pending", "in_flight", "failed", "delivered", "retry_started", "proxy_unavailable"].includes(fields.queueState ?? "")) safe.queueState = fields.queueState;

      if (bootstrapPhases.some((phase) => phase === fields.phase)) safe.phase = fields.phase;

      if (fields.messageKind === "chat" || fields.messageKind === "friend") safe.messageKind = fields.messageKind;

      if (["controller_received", "controller_accepted", "decoded", "message_decoded", "refresh_requested", "state_updated", "rendered", "duplicate_rejected", "decode_failed", "verified", "decrypted", "stored", "displayed", "replay_rejected", "failed"].includes(fields.deliveryStage ?? "")) safe.deliveryStage = fields.deliveryStage;

      if (["direct", "sync_response", "relay", "unknown"].includes(fields.deliveryPath ?? "")) safe.deliveryPath = fields.deliveryPath;

      if (fields.deliveryOccurrence === "first" || fields.deliveryOccurrence === "later") safe.deliveryOccurrence = fields.deliveryOccurrence;

      if (typeof fields.conversationOpen === "boolean") safe.conversationOpen = fields.conversationOpen;

      if (["worker", "queue", "controller", "hidden_service"].includes(fields.stage ?? "")) safe.stage = fields.stage;

      if (["bootstrap_timeout", "socks_timeout", "process_exit", "spawn_error", "cancelled", "data_dir_conflict", "mac_signature_repair", "system_tor_fallback", "bridge_fallback", "bridge_unavailable", "binary_missing"].includes(fields.reason ?? "")) safe.reason = fields.reason;

      if (["invalid_address", "proxy_unavailable", "backoff", "proxy_changed", "native_unavailable", "connection_refused", "proxy_error", "socks_error", "http_error", "timeout", "unknown"].includes(fields.errorCategory ?? "")) safe.errorCategory = fields.errorCategory;

      if (["network", "cache", "in_flight", "rejected"].includes(fields.disposition ?? "")) safe.disposition = fields.disposition;

      for (const key of ["attempt", "span", "progress", "durationMs", "elapsedMs", "lastProgressMs", "stallMs", "laneIndex", "httpStatus", "exitCode", "cacheFiles", "cacheBytes", "rendererMs", "queueAgeMs", "dueInMs", "dueLatenessMs", "retryStartMs", "nextDueInMs", "socksDurationMs", "attemptDurationMs", "workerSlotsUsed", "priorAttempts", "priorNetworkMs"] as const) {
        if (typeof fields[key] === "number" && Number.isFinite(fields[key]) && fields[key]! >= 0) safe[key] = fields[key];
      }

      for (const key of ["hsConfigured", "socksReady", "bootstrapReady", "processRunning", "expectedExit", "proxyReady", "torRunning", "socksStarted", "connectionReused"] as const) {
        if (typeof fields[key] === "boolean") safe[key] = fields[key];
      }

      if (typeof fields.observedMs === "number" && Number.isFinite(fields.observedMs) && fields.observedMs >= 0) safe.observedMs = fields.observedMs;
      this.buffer.push(JSON.stringify({ runId: this.runId, event, msFromMainProcessStart: performance.now() - this.origin, ...safe }) + "\n");
      this.total++;
      this.schedule();
    } catch { this.disable(); }
  }

  begin(event: Event, fields: Fields = {}) {
    if (!this.enabled) return noop;
    const started = performance.now();
    const span = ++this.spanId;
    this.mark(event, { ...fields, span });
    let ended = false;

    return (endEvent: Event, outcome?: Fields["outcome"], details: Fields = {}) => {
      if (ended) return;
      ended = true;
      this.mark(endEvent, { ...fields, ...details, span, outcome, durationMs: performance.now() - started });
    };
  }
  elapsedNow() { return performance.now() - this.origin; }

  private schedule() {
    if (!this.file || this.scheduled || !this.enabled) return;
    this.scheduled = true;
    this.tail = this.tail.then(async () => {
      if (!this.enabled) return;
      const batch = this.buffer.join("");
      this.buffer = [];

      if (batch) await fs.appendFile(this.file!, batch, "utf8");
    }).catch(() => this.disable()).finally(() => {
      this.scheduled = false;

      if (this.buffer.length) this.schedule();
    });
  }

  private disable() {
    this.enabled = false;
    this.buffer = [];
  }

  /** Tests/collectors only; application startup never awaits trace I/O. */
  async flush() {
    while (this.scheduled) await this.tail;
  }
}

export const coldStartTelemetry = new ColdStartTelemetry();
