import { countSessionStage } from "../diagnostics/sessionInvestigation";
import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { coldStartTelemetry as cold } from "./coldStartTelemetry";
import { classifyTorProbeError, getTorProbeErrorCode, getProbeNetworkStage } from "./torProbeError";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import type { TorStatus } from "./torManager";
import { ownedBinaryRetryId, type SocksTransport } from "./socksHttpClient";
import { decodeBinaryTransportPacketV2 } from "../adapters/transports/packetCodec";
import { emitFlowTraceLog } from "../diagnostics/infoCollectionLogs";
import { ONION_CONTROLLER_MAX_BODY_BYTES } from "../net/mediaTransferLimits";
import { appendTestLogRecord } from "./testLogStore";
import { validateLocalAccountId } from "./accountSessionAuthority";

type MailboxOwner = { accountId: string; sessionToken?: string; assertCurrent: () => void };

type InboxItem = {
  index: number;
  id: string;
  ts: number;
  from: string;
  envelope: string | Uint8Array;
  expiresAt: number;
  admission: "authenticated" | "legacy";
};

type InboxState = {
  baseIndex: number;
  nextIndex?: number;
  bytes: number;
  legacyBytes: number;
  legacyItems: number;
  items: InboxItem[];
};

type ForwardingState = {
  proxyUrl: string | null;
  proxyUrls: string[];
  nextProxyIndex: number;
  ready: boolean;
};

export type OnionControllerHandle = {
  send: (payload: OnionSendPayload, owner?: MailboxOwner) => Promise<{ status: number; body: Record<string, unknown> }>;
  acknowledgeInboxItems: (deviceId: string, itemIds: string[], owner: MailboxOwner) => boolean;
  readInboxItems: (deviceId: string, token: string, scanAfter: number, limit: number, owner: MailboxOwner) => { ok: boolean; items: InboxItem[]; nextAfter: string | null; error?: string };
  getMailboxOwner: (deviceId: string) => string | undefined;
  hasRetainedInboxItem: (deviceId: string, operationId: string) => boolean;
  baseUrl: string;
  port: number;
  authToken: string;
  setTorSocksProxy: (proxyUrl: string | null) => Promise<void>;
  setTorSocksProxies: (proxyUrls: string[], primaryProxyUrl?: string | null) => Promise<void>;
  setTorOnionHost: (host: string | null) => void;
  prewarmTorRoute: (
    onionAddress: string,
    options?: { timeoutMs?: number }
  ) => Promise<{ ok: boolean; elapsedMs: number; error?: string }>;
  registerMailbox: (
    deviceId: string,
    options?: { persistent?: boolean; owner?: MailboxOwner }
  ) => Promise<{ ok: boolean; inboxWriteToken?: string; error?: string }>;
  unregisterMailbox: (deviceId: string, owner?: MailboxOwner) => Promise<{ ok: boolean; error?: string }>;
  close: () => Promise<void>;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS = 60 * 1000;

const MAX_BODY_BYTES = ONION_CONTROLLER_MAX_BODY_BYTES;

const MAX_INBOX_BYTES = 64 * 1024 * 1024;

const MAX_DEVICE_INBOX_BYTES = 32 * 1024 * 1024;

const MAX_INBOX_ITEMS = 4096;

const MAX_DEVICE_INBOX_ITEMS = 2048;

const MAX_LEGACY_INBOX_BYTES = 2 * 1024 * 1024;

const MAX_DEVICE_LEGACY_INBOX_BYTES = 512 * 1024;

const MAX_LEGACY_INBOX_ITEMS = 128;

const MAX_DEVICE_LEGACY_INBOX_ITEMS = 32;

const LEGACY_TTL_MS = 24 * 60 * 60 * 1000;

const INGEST_RATE_WINDOW_MS = 1000;

const MAX_INGESTS_PER_WINDOW = 120;

const FORWARD_TIMEOUT_MS = 45_000;

const KEEP_ALIVE_TIMEOUT_MS = 65_000;

const TOR_PREWARM_CACHE_MS = 45_000;

const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<{ ok: boolean; body?: Buffer; error?: string }>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (payload: { ok: boolean; body?: Buffer; error?: string }) => {
      if (done) return;
      done = true;
      resolve(payload);
    };

    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;

      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: "body-too-large" });
        req.destroy();

        return;
      }

      chunks.push(buf);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("aborted", () => finish({ ok: false, error: "read-aborted" }));
    req.on("close", () => {
      if (!req.complete) finish({ ok: false, error: "read-aborted" });
    });
    req.on("error", () => finish({ ok: false, error: "read-error" }));
  });

export type OnionSendPayload = {
  to?: string;
  from?: string;
  envelope?: string | Uint8Array;
  ttlMs?: number;
  toDeviceId?: string;
  toOnion?: string;
  fromDeviceId?: string;
  route?: {
    mode?: "auto" | "preferTor" | "manual";
    torOnion?: string;
    inboxWriteToken?: string;
  };
};

type OnionSendDeps = {
  now: () => number;
  uuid: () => string;
  storeLocal: (
    deviceId: string,
    item: Omit<InboxItem, "expiresAt" | "admission" | "index"> & { ttlMs?: number }
  ) => boolean | void;
  forwardRouted?: (
    payload: OnionSendPayload
  ) => Promise<{
    status: number;
    body: Record<string, unknown>;
    traces?: Array<Record<string, unknown> & { event: string }>;
  }>;
  emitTrace?: (detail: {
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    [key: string]: unknown;
  }) => void;
};

export const handleOnionSend = async (payload: OnionSendPayload, deps: OnionSendDeps) => {
  const emitTrace = deps.emitTrace ?? ((detail) => emitFlowTraceLog(detail));

  if (!payload || typeof payload !== "object" ||
      !(typeof payload.envelope === "string" && payload.envelope || payload.envelope instanceof Uint8Array && payload.envelope.byteLength)) {
    return { status: 400, body: { ok: false, error: "missing-fields" } };
  }

  const toDeviceId = payload.toDeviceId ?? payload.to;
  const fromDeviceId = payload.fromDeviceId ?? payload.from ?? "";

  if (typeof toDeviceId !== "string" || !toDeviceId) {
    return { status: 400, body: { ok: false, error: "missing-to-device" } };
  }

  if (toDeviceId.length > 256 || typeof fromDeviceId !== "string" || fromDeviceId.length > 256) {
    return { status: 400, body: { ok: false, error: "invalid-device-id" } };
  }

  const hasRouteTargets = Boolean(
    payload.toOnion ||
      payload.route?.torOnion ||
      payload.to?.includes(".onion") ||
      payload.route
  );

  if (hasRouteTargets) {
    if (!deps.forwardRouted) {
      return {
        status: 502,
        body: { ok: false, error: "forward_failed:native_transport_unavailable" },
      };
    }

    try {
      const result = await deps.forwardRouted(payload);
      result.traces?.forEach((trace) => emitTrace(trace));

      return { status: result.status, body: result.body };
    } catch (error) {
      emitTrace({
        event: "onionController:forward:error",
        level: "error",
        reason: error instanceof Error ? error.message : String(error),
      });

      return {
        status: 502,
        body: { ok: false, error: "forward_failed:native_transport_error" },
      };
    }
  }

  // Legacy/local fallback is only safe for explicit loopback sends.
  if (payload.envelope instanceof Uint8Array || fromDeviceId && fromDeviceId !== toDeviceId) {
    return { status: 400, body: { ok: false, error: "forward_failed:no_route_target" } };
  }

  const msgId = deps.uuid();
  const ts = deps.now();

  const stored = deps.storeLocal(toDeviceId, {
    id: msgId,
    ts,
    from: fromDeviceId,
    envelope: payload.envelope,
    ttlMs: payload.ttlMs,
  });

  if (stored === false) {
    return { status: 429, body: { ok: false, error: "inbox-capacity-exceeded" } };
  }

  return { status: 200, body: { ok: true, msgId, forwarded: false } };
};

export const startOnionController = async (options?: {
  port?: number;
  getTorStatus?: () => TorStatus;
  userDataPath?: string;
  queueOnFailure?: boolean;
  socksTransport?: SocksTransport;
  onInboundDiagnostic?: (envelope: string, stage: "controller_received" | "controller_accepted",
    timing: { requestBodyMs: number; requestBytes: number; admissionMs: number }) => void;
}): Promise<OnionControllerHandle> => {
  const host = "127.0.0.1";
  const port = options?.port ?? 3210;
  const authToken = `${randomUUID()}${randomUUID()}`;
  const inbox = new Map<string, InboxState>();
  const mailboxCapabilities = new Map<string, string>();
  const mailboxOwners = new Map<string, string>(); // Metadata on the existing mailbox records.
  const ephemeralMailboxes = new Set<string>();
  const persistentMailboxAliases = new Map<string, string>();
  let activatePersistentMailbox: (deviceId: string) => void = () => undefined;
  let inboxBytes = 0;
  let inboxItems = 0;
  let legacyInboxBytes = 0;
  let legacyInboxItems = 0;
  let ingestWindowStartedAt = Date.now();
  let ingestWindowCount = 0;

  const mailboxFile = options?.userDataPath
    ? path.join(options.userDataPath, "onion-mailboxes-v1.json")
    : null;

  if (mailboxFile) {
    try {
      const parsed = JSON.parse(await readFile(mailboxFile, "utf8")) as {
        mailboxes?: Record<string, string | { token: string; status: "bound" | "unbound"; accountId?: string }>;
      };

      for (const [deviceId, record] of Object.entries(parsed.mailboxes ?? {})) {
        const token = typeof record === "string" ? record : record?.token;

        if (
          deviceId.length > 0 &&
          deviceId.length <= 256 &&
          typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
        ) {
          mailboxCapabilities.set(deviceId, token);

          if (typeof record !== "string") {
            if (record.status === "bound") mailboxOwners.set(deviceId, validateLocalAccountId(record.accountId));
            else if (record.status !== "unbound" || record.accountId !== undefined) throw new Error("MAILBOX_RECORD_INVALID");
          }
        } else throw new Error("MAILBOX_RECORD_INVALID");
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code ?? "")
          : "";

      if (code !== "ENOENT") throw error;
    }
  }

  let persistMailboxChain = Promise.resolve();

  const serializeMailboxWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const result = persistMailboxChain.catch(() => undefined).then(work);
    persistMailboxChain = result.then(() => undefined);

    return result;
  };

  const persistMailboxes = async (assertCurrent?: () => void) => {
    if (!mailboxFile) return Promise.resolve();
      await mkdir(path.dirname(mailboxFile), { recursive: true });
      const temporaryPath = `${mailboxFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({
          v: 2,
          mailboxes: Object.fromEntries(
            [...mailboxCapabilities].filter(([deviceId]) => !ephemeralMailboxes.has(deviceId))
              .map(([deviceId, token]) => [deviceId, mailboxOwners.has(deviceId)
                ? { token, status: "bound", accountId: mailboxOwners.get(deviceId) }
                : { token, status: "unbound" }])
          ),
        }),
        { encoding: "utf8", mode: 0o600 }
      );

      try {
        assertCurrent?.();
        await rename(temporaryPath, mailboxFile);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
  };

  const registerMailbox = async (
    deviceIdValue: string,
    registerOptions?: { persistent?: boolean; owner?: MailboxOwner }
  ) => serializeMailboxWrite(async () => {
    const owner = registerOptions?.owner;

    if (registerOptions?.persistent !== false && !owner) return { ok: false, error: "OWNER_REQUIRED" };
    owner?.assertCurrent();

    if (owner) validateLocalAccountId(owner.accountId);
    const deviceId = typeof deviceIdValue === "string" ? deviceIdValue.trim() : "";

    if (!deviceId || deviceId.length > 256) {
      return { ok: false, error: "invalid-device-id" };
    }

    const existing = mailboxCapabilities.get(deviceId);

    if (existing) {
      if (owner && !mailboxOwners.has(deviceId)) return { ok: false, error: "MAILBOX_OWNER_UNBOUND" };

      if (owner && mailboxOwners.get(deviceId) !== owner.accountId) return { ok: false, error: "MAILBOX_OWNER_MISMATCH" };

      if (registerOptions?.persistent !== false && ephemeralMailboxes.delete(deviceId)) {
        try {
          await persistMailboxes(owner?.assertCurrent);
          activatePersistentMailbox(deviceId);
        } catch {
          ephemeralMailboxes.add(deviceId);

          return { ok: false, error: "mailbox-persistence-failed" };
        }
      } else if (registerOptions?.persistent !== false) {
        activatePersistentMailbox(deviceId);
      }

      return { ok: true, inboxWriteToken: existing };
    }

    const inboxWriteToken = randomBytes(32).toString("base64url");
    mailboxCapabilities.set(deviceId, inboxWriteToken);

    if (registerOptions?.persistent === false) {
      ephemeralMailboxes.add(deviceId);

      return { ok: true, inboxWriteToken };
    }

    if (owner) mailboxOwners.set(deviceId, owner.accountId);

    try {
      await persistMailboxes(owner?.assertCurrent);
      activatePersistentMailbox(deviceId);

      return { ok: true, inboxWriteToken };
    } catch {
      mailboxCapabilities.delete(deviceId);
      mailboxOwners.delete(deviceId);

      return { ok: false, error: "mailbox-persistence-failed" };
    }
  });

  const unregisterMailbox = async (deviceIdValue: string, owner?: MailboxOwner) => serializeMailboxWrite(async () => {
    owner?.assertCurrent();
    const deviceId = typeof deviceIdValue === "string" ? deviceIdValue.trim() : "";

    if (!deviceId || deviceId.length > 256) {
      return { ok: false, error: "invalid-device-id" };
    }

    const previousCapability = mailboxCapabilities.get(deviceId);
    const previousInbox = inbox.get(deviceId);
    const previousOwner = mailboxOwners.get(deviceId);

    if (mailboxCapabilities.has(deviceId) && !ephemeralMailboxes.has(deviceId) && !owner) {
      return { ok: false, error: "OWNER_REQUIRED" };
    }

    if (owner && previousOwner !== owner.accountId) return { ok: false, error: "MAILBOX_OWNER_MISMATCH" };
    const wasEphemeral = ephemeralMailboxes.has(deviceId);
    mailboxCapabilities.delete(deviceId);
    ephemeralMailboxes.delete(deviceId);
    mailboxOwners.delete(deviceId);

    try {
      if (!wasEphemeral) await persistMailboxes(owner?.assertCurrent);

      for (const [source, target] of persistentMailboxAliases) {
        if (source === deviceId || target === deviceId) persistentMailboxAliases.delete(source);
      }

      if (previousInbox) {
        removeItems(previousInbox, previousInbox.items.length);
        inbox.delete(deviceId);
      }

      return { ok: true };
    } catch {
      if (previousCapability) mailboxCapabilities.set(deviceId, previousCapability);

      if (previousOwner) mailboxOwners.set(deviceId, previousOwner);

      if (wasEphemeral) ephemeralMailboxes.add(deviceId);

      if (previousInbox) inbox.set(deviceId, previousInbox);

      return { ok: false, error: "mailbox-persistence-failed" };
    }
  });

  const matchesMailboxCapability = (expected: string, candidate: string) => {
    const expectedBytes = Buffer.from(expected, "utf8");
    const candidateBytes = Buffer.from(candidate, "utf8");

    return (
      expectedBytes.length === candidateBytes.length &&
      timingSafeEqual(expectedBytes, candidateBytes)
    );
  };

  const torForwarding: ForwardingState = {
    proxyUrl: null,
    proxyUrls: [],
    nextProxyIndex: 0,
    ready: false,
  };

  const torPrewarmSuccess = new Map<string, number>();
  const torPrewarmFailures = new Map<string, { failures: number; retryAt: number }>();
  let proxyGeneration = 0;
  const proxyCooldown = new Map<string, number>();

  const recordProxyFailure = (proxy: string, error: unknown, generation: number) => {
    if (generation !== proxyGeneration) return;
    const detail = error instanceof Error ? error.message : String(error);

    if (/proxy_unreachable|proxy_connect|socks_handshake|socks_auth/.test(detail)) {
      proxyCooldown.set(proxy, Date.now() + 30_000);
      torPrewarmSuccess.clear();
    }
  };

  const torPrewarmInFlight = new Map<
    string,
    Promise<{ ok: boolean; elapsedMs: number; error?: string }>
  >();

  const emitControllerTrace = (detail: {
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    [key: string]: unknown;
  }) => {
    emitFlowTraceLog(detail);

    if (!options?.userDataPath) return;
    void appendTestLogRecord(options.userDataPath, {
      channel: "router",
      event: {
        ...detail,
        timestamp: new Date().toISOString(),
      },
    }).catch((error) => {
      console.warn("[test-log] main trace append failed", error);
    });
  };

  let myTorOnionHost: string | null = null;

  const socksTransport: SocksTransport =
    options?.socksTransport ?? {
      fetch: async () => {
        throw new Error("native_transport_unavailable");
      },
      forward: async () => ({
        status: 502,
        body: { ok: false, error: "forward_failed:native_transport_unavailable" },
      }),
      clearProxy: async () => undefined,
    };

  let primaryTorSocksProxy: string | null = null;

  const setTorSocksProxies = async (proxyUrls: string[], primaryProxyUrl?: string | null) => {
    const normalized = [...new Set(proxyUrls.map((value) => value.trim()).filter(Boolean))];
    // Pool positions change when a manager stops; they are not process identities.
    primaryTorSocksProxy = primaryProxyUrl === undefined ? normalized[0] ?? null : primaryProxyUrl?.trim() || null;
    const previous = torForwarding.proxyUrls;

    if (previous.join("\n") === normalized.join("\n")) {
      torForwarding.proxyUrl = normalized[0] ?? null;
      torForwarding.ready = normalized.length > 0;

      return;
    }

    torPrewarmSuccess.clear();
    torPrewarmInFlight.clear();
    torPrewarmFailures.clear();
    proxyGeneration += 1;
    proxyCooldown.clear();
    torForwarding.proxyUrls = normalized;
    torForwarding.proxyUrl = normalized[0] ?? null;
    torForwarding.nextProxyIndex = 0;
    torForwarding.ready = normalized.length > 0;

    for (const previousProxy of previous) {
      if (!normalized.includes(previousProxy)) await socksTransport.clearProxy(previousProxy);
    }
  };

  const setTorSocksProxy = (proxyUrl: string | null) =>
    setTorSocksProxies(proxyUrl?.trim() ? [proxyUrl] : []);

  const selectTorProxy = () => {
    if (torForwarding.proxyUrls.length === 0) return null;
    let laneIndex = torForwarding.nextProxyIndex % torForwarding.proxyUrls.length;

    for (let offset = 0; offset < torForwarding.proxyUrls.length; offset += 1) {
      const index = (laneIndex + offset) % torForwarding.proxyUrls.length;

      if ((proxyCooldown.get(torForwarding.proxyUrls[index]) ?? 0) <= Date.now()) {
        laneIndex = index;
        break;
      }
    }

    const selected = torForwarding.proxyUrls[laneIndex];
    torForwarding.nextProxyIndex = (laneIndex + 1) % torForwarding.proxyUrls.length;

    return selected
      ? {
          proxyUrl: selected,
          lane: laneIndex + 1,
          laneCount: torForwarding.proxyUrls.length,
          role: selected === primaryTorSocksProxy ? "primary" as const : "secondary" as const,
        }
      : null;
  };

  let firstForwardObserved = false;

  const prewarmTorRoute = async (onionAddress: string, probeOptions?: { timeoutMs?: number }) => {
    const startedAt = Date.now();
    const normalized = onionAddress.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    const target = normalized === myTorOnionHost ? "self" as const : "other" as const;

    const readiness = () => {
      let torRunning: boolean | undefined;

      try {
        const status = options?.getTorStatus?.();

        if (status) torRunning = status.state === "running";
      } catch { /* Diagnostics must not change the probe result. */ }

      return { target, proxyReady: torForwarding.ready, torRunning };
    };

    if (!/^[a-z2-7]{56}\.onion$/.test(normalized)) {
      cold.mark("prewarm.result", { ...readiness(), disposition: "rejected", errorCategory: "invalid_address", outcome: "failed" });

      return { ok: false, elapsedMs: Date.now() - startedAt, error: "invalid-onion-address" };
    }

    // Disposable E2E profiles only: compare route health traffic with normal
    // messages. Production and all unflagged runs keep the existing probe.
    if (target === "self" && process.env.NKC_E2E_USER_DATA_DIR && process.env.NKC_TEST_DISABLE_SELF_PREWARM === "1") {
      cold.mark("prewarm.result", { ...readiness(), disposition: "rejected", outcome: "unavailable" });

      return { ok: false, elapsedMs: Date.now() - startedAt, error: "test-self-probe-disabled" };
    }

    if (!torForwarding.ready || !torForwarding.proxyUrl) {
      cold.mark("prewarm.result", { ...readiness(), disposition: "rejected", errorCategory: "proxy_unavailable", outcome: "failed" });

      return { ok: false, elapsedMs: Date.now() - startedAt, error: "tor-proxy-unavailable" };
    }

    const availableProxies = torForwarding.proxyUrls.filter(
      (proxy) => (proxyCooldown.get(proxy) ?? 0) <= Date.now()
    );

    // If every lane failed, allow recovery instead of suppressing all probes.
    const proxyUrls = availableProxies.length ? availableProxies : [...torForwarding.proxyUrls];
    const generation = proxyGeneration;
    const cachedAt = torPrewarmSuccess.get(normalized) ?? 0;

    if (Date.now() - cachedAt < TOR_PREWARM_CACHE_MS) {
      cold.mark("prewarm.result", { ...readiness(), disposition: "cache", outcome: "ok" });

      return { ok: true, elapsedMs: Date.now() - startedAt };
    }

    const existing = torPrewarmInFlight.get(normalized);

    if (existing) {
      cold.mark("prewarm.result", { ...readiness(), disposition: "in_flight" });

      return existing;
    }

    const failure = torPrewarmFailures.get(normalized);

    if (failure && Date.now() < failure.retryAt) {
      cold.mark("prewarm.result", { ...readiness(), disposition: "rejected", errorCategory: "backoff", outcome: "failed" });

      return { ok: false, elapsedMs: Date.now() - startedAt, error: "tor-prewarm-backoff" };
    }

    const endProbe = cold.begin("prewarm.network.begin", { target });
    cold.mark("prewarm.result", { ...readiness(), disposition: "network" });

    const probe = (async () => {
      try {
        const timeoutMs = Math.max(
          3_000,
          Math.min(FORWARD_TIMEOUT_MS, probeOptions?.timeoutMs ?? FORWARD_TIMEOUT_MS)
        );

        const probes = proxyUrls.map(async (proxyUrl) => {
          const laneIndex = torForwarding.proxyUrls.indexOf(proxyUrl) + 1;
          const endLane = cold.begin("prewarm.lane.begin", { ...readiness(), laneIndex });

          try {
            const response = await socksTransport.fetch(`http://${normalized}/onion/health`, {
              method: "GET",
              socksProxyUrl: proxyUrl,
              timeoutMs,
              diagnose: process.env.NKC_COLD_START_TRACE === "1",
            });

            if (response.status !== 200) {
              endLane("prewarm.lane.end", "failed", { ...readiness(), httpStatus: response.status, errorCategory: "http_error" });
              throw new Error(`prewarm-http-${response.status}`);
            }

            endLane("prewarm.lane.end", "ok", { ...readiness(), httpStatus: response.status });

            return proxyUrl;
          } catch (error) {
            const category = classifyTorProbeError(error);
            endLane("prewarm.lane.end", "failed", { ...readiness(), errorCategory: category, errorCode: getTorProbeErrorCode(error), networkStage: getProbeNetworkStage(error) });
            recordProxyFailure(proxyUrl, error, generation);
            throw error;
          }
        });

        const winningProxy = await Promise.any(probes);
        const elapsedMs = Date.now() - startedAt;

        if (generation !== proxyGeneration) {
          cold.mark("prewarm.result", { ...readiness(), disposition: "network", errorCategory: "proxy_changed", outcome: "failed" });
          endProbe("prewarm.network.end", "failed");

          return { ok: false, elapsedMs, error: "tor-proxy-changed" };
        }

        proxyCooldown.delete(winningProxy);
        torPrewarmFailures.delete(normalized);
        torPrewarmSuccess.set(normalized, Date.now());
        const winningIndex = torForwarding.proxyUrls.indexOf(winningProxy);
        // Prefer the successful probe without changing the configured ordering.
        // Regular proxy synchronization must not reset failure cooldowns.
        torForwarding.nextProxyIndex = Math.max(0, winningIndex);
        endProbe("prewarm.network.end", "ok");

        return { ok: true, elapsedMs };
      } catch (error) {
        endProbe("prewarm.network.end", "failed");

        if (generation === proxyGeneration) {
          const failures = Math.min(5, (torPrewarmFailures.get(normalized)?.failures ?? 0) + 1);
          torPrewarmFailures.delete(normalized);

          if (torPrewarmFailures.size >= 256) {
            torPrewarmFailures.delete(torPrewarmFailures.keys().next().value!);
          }

          torPrewarmFailures.set(normalized, {
            failures,
            retryAt: Date.now() + Math.min(30_000, 2_000 * 2 ** (failures - 1)),
          });
        }

        return {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: "tor-prewarm-failed:" +
            (error instanceof AggregateError ? error.errors.slice(0, proxyUrls.length) : [error])
              .map(cause => `${getProbeNetworkStage(cause)}/${getTorProbeErrorCode(cause)}/${classifyTorProbeError(cause)}`)
              .join(","),
        };
      }
    })();

    torPrewarmInFlight.set(normalized, probe);

    return probe.finally(() => {
      if (torPrewarmInFlight.get(normalized) === probe) torPrewarmInFlight.delete(normalized);
    });
  };

  const setTorOnionHost = (hostValue: string | null) => {
    const trimmed = hostValue?.trim() ?? "";
    myTorOnionHost = trimmed ? trimmed : null;
  };

  const getItemBytes = (item: Pick<InboxItem, "id" | "from" | "envelope">) =>
    Buffer.byteLength(item.id, "utf8") +
    Buffer.byteLength(item.from, "utf8") +
    (typeof item.envelope === "string" ? Buffer.byteLength(item.envelope, "utf8") : item.envelope.byteLength) +
    32;

  const enqueue = (
    deviceId: string,
    item: Omit<InboxItem, "expiresAt" | "admission" | "index"> & {
      ttlMs?: number;
      admission?: "authenticated" | "legacy";
    }
  ) => {
    const admission = item.admission ?? "authenticated";

    const ttlMs =
      admission === "legacy"
        ? Math.min(item.ttlMs ?? LEGACY_TTL_MS, LEGACY_TTL_MS)
        : item.ttlMs ?? DEFAULT_TTL_MS;

    const expiresAt = item.ts + ttlMs;
    const entry: InboxItem = { ...item, admission, expiresAt, index: 0 };
    const entryBytes = getItemBytes(entry);

    const state = inbox.get(deviceId) ?? {
      baseIndex: 0,
      bytes: 0,
      legacyBytes: 0,
      legacyItems: 0,
      items: [],
    };

    const duplicate = state.items.find(existing => existing.id === item.id);

    if (duplicate) {
      if (duplicate.envelope instanceof Uint8Array || item.envelope instanceof Uint8Array) {
        return duplicate.envelope instanceof Uint8Array && item.envelope instanceof Uint8Array &&
          Buffer.compare(duplicate.envelope, item.envelope) === 0;
      }

      return true;
    }

    if (
      inboxItems >= MAX_INBOX_ITEMS ||
      state.items.length >= MAX_DEVICE_INBOX_ITEMS ||
      inboxBytes + entryBytes > MAX_INBOX_BYTES ||
      state.bytes + entryBytes > MAX_DEVICE_INBOX_BYTES ||
      (admission === "legacy" &&
        (legacyInboxItems >= MAX_LEGACY_INBOX_ITEMS ||
          state.legacyItems >= MAX_DEVICE_LEGACY_INBOX_ITEMS ||
          legacyInboxBytes + entryBytes > MAX_LEGACY_INBOX_BYTES ||
          state.legacyBytes + entryBytes > MAX_DEVICE_LEGACY_INBOX_BYTES))
    ) {
      return false;
    }

    entry.index = state.nextIndex ?? state.baseIndex + state.items.length;
    state.nextIndex = entry.index + 1;
    state.items.push(entry);
    state.bytes += entryBytes;

    if (admission === "legacy") {
      state.legacyBytes += entryBytes;
      state.legacyItems += 1;
      legacyInboxBytes += entryBytes;
      legacyInboxItems += 1;
    }

    inboxBytes += entryBytes;
    inboxItems += 1;
    inbox.set(deviceId, state);

    return true;
  };

  const removeItems = (state: InboxState, count: number, start = 0) => {
    if (count <= 0) return;
    const removed = state.items.splice(start, count);
    let removedBytes = 0, removedLegacyBytes = 0, removedLegacyCount = 0;

    for (const item of removed) {
      const bytes = getItemBytes(item);
      removedBytes += bytes;

      if (item.admission === "legacy") { removedLegacyBytes += bytes; removedLegacyCount++; }
    }

    state.baseIndex = state.items[0]?.index ?? state.nextIndex ?? state.baseIndex + removed.length;
    state.bytes = Math.max(0, state.bytes - removedBytes);
    state.legacyBytes = Math.max(0, state.legacyBytes - removedLegacyBytes);
    state.legacyItems = Math.max(0, state.legacyItems - removedLegacyCount);
    inboxBytes = Math.max(0, inboxBytes - removedBytes);
    inboxItems = Math.max(0, inboxItems - removed.length);
    legacyInboxBytes = Math.max(0, legacyInboxBytes - removedLegacyBytes);
    legacyInboxItems = Math.max(0, legacyInboxItems - removedLegacyCount);
  };

  activatePersistentMailbox = (deviceId: string) => {
    const owner = mailboxOwners.get(deviceId);

    if (!owner) return; // Historical ownership is never inferred from the active account.

    for (const [source] of persistentMailboxAliases) {
      if (mailboxOwners.get(source) === owner) persistentMailboxAliases.delete(source);
    }

    const migratedItems: InboxItem[] = [];

    for (const [mailboxId] of mailboxCapabilities) {
      if (mailboxId === deviceId || ephemeralMailboxes.has(mailboxId) || mailboxOwners.get(mailboxId) !== owner) continue;
      persistentMailboxAliases.set(mailboxId, deviceId);
      const previousState = inbox.get(mailboxId);

      if (!previousState) continue;
      migratedItems.push(...previousState.items);
      removeItems(previousState, previousState.items.length);
      inbox.delete(mailboxId);
    }

    if (migratedItems.length === 0) return;
    const currentState = inbox.get(deviceId);

    if (currentState) {
      migratedItems.push(...currentState.items);
      removeItems(currentState, currentState.items.length);
      inbox.delete(deviceId);
    }

    const seen = new Set<string>();

    for (const item of migratedItems.sort((left, right) => left.ts - right.ts)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      enqueue(deviceId, {
        id: item.id,
        ts: item.ts,
        from: item.from,
        envelope: item.envelope,
        ttlMs: Math.max(0, item.expiresAt - item.ts),
        admission: item.admission,
      });
    }
  };

  const cleanup = () => {
    const now = Date.now();

    for (const [deviceId, state] of inbox.entries()) {
      const expiredCount = state.items.findIndex((item) => item.expiresAt > now);

      if (expiredCount < 0) {
        removeItems(state, state.items.length);

        // Registered readers retain their cursor across idle/expired inboxes.
        // Resetting baseIndex would let an old cursor discard newly arrived data.
        if (!mailboxCapabilities.has(deviceId)) inbox.delete(deviceId);
      } else if (expiredCount > 0) {
        removeItems(state, expiredCount);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

  let closing = false;

  const send = async (payload: OnionSendPayload, owner?: MailboxOwner) => {
    if (closing) return { status: 503, body: { ok: false, error: "controller-closing" } };
    const from = payload?.fromDeviceId ?? payload?.from ?? "";
    const accountId = mailboxOwners.get(from);

    if ((accountId && !owner) || (owner && accountId !== owner.accountId)) {
      return { status: 403, body: { ok: false, error: "MAILBOX_OWNER_MISMATCH" } };
    }

    owner?.assertCurrent();

    return handleOnionSend(payload, {
        now: () => Date.now(),
        uuid: () => randomUUID(),
        storeLocal: (deviceId, item) => { owner?.assertCurrent();

 return enqueue(deviceId, item); },
        forwardRouted: async (routedPayload) => {
          owner?.assertCurrent();
          const selectedProxy = selectTorProxy();
          const generation = proxyGeneration;
          const routeHost = routedPayload.route?.torOnion?.trim().toLowerCase();
          emitControllerTrace({
            event: "onionController:torLane:selected",
            lane: selectedProxy?.lane ?? null,
            laneCount: selectedProxy?.laneCount ?? 0,
            laneRole: selectedProxy?.role ?? null,
          });

          const endForward = !firstForwardObserved
            ? cold.begin("p2p.first_forward.begin", { lane: selectedProxy?.role })
            : undefined;

          firstForwardObserved = true;
          let result;

          try {
            result = await socksTransport.forward(routedPayload, {
              torProxyUrl: selectedProxy?.proxyUrl ?? null,
              queueOnFailure: options?.queueOnFailure ?? true,
              owner,
            });
            endForward?.("p2p.first_forward.result", result.status === 200 && result.body.ok
              ? result.body.forwarded === true && result.body.via === "tor" ? "ok"
                : result.body.queued === true ? "queued" : "unavailable"
              : "failed");
          } catch (error) {
            endForward?.("p2p.first_forward.result", "failed");

            if (generation === proxyGeneration && routeHost) torPrewarmSuccess.delete(routeHost);

            if (selectedProxy) recordProxyFailure(selectedProxy.proxyUrl, error, generation);
            throw error;
          }

          if (selectedProxy) recordProxyFailure(selectedProxy.proxyUrl, result.body.error ?? "", generation);

          if (generation === proxyGeneration && routeHost) {
            // A native queue acknowledgement is not a live Tor exchange.
            if (result.status === 200 && result.body.ok && result.body.forwarded === true && result.body.via === "tor") {
              torPrewarmFailures.delete(routeHost);
              torPrewarmSuccess.set(routeHost, Date.now());
            } else {
              torPrewarmSuccess.delete(routeHost);
            }
          }

          return result;
        },
        emitTrace: emitControllerTrace,
      });
  };

  const server = http.createServer(async (req, res) => {
    if (closing) {
      sendJson(res, 503, { ok: false, error: "controller-shutting-down" });

      return;
    }

    if (req.headers.origin || req.method === "OPTIONS") {
      sendJson(res, 403, { ok: false, error: "browser-origin-blocked" });

      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorized = req.headers["x-nkc-controller-token"] === authToken;

    const localOnlyRoute =
      url.pathname === "/onion/address" ||
      url.pathname === "/onion/send" ||
      url.pathname === "/onion/inbox";

    if (localOnlyRoute && !authorized) {
      sendJson(res, 401, { ok: false, error: "controller-auth-required" });

      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/health") {
      cold.mark("controller.health.received");
      const torStatus = options?.getTorStatus ? options.getTorStatus() : null;

      const torActive = Boolean(
        torStatus &&
          torStatus.state === "running" &&
          torForwarding.ready &&
          torForwarding.proxyUrl
      );

      const details = torActive ? "route proxy enabled" : "local-only mode";
      const network = torActive ? "tor" : "none";
      sendJson(res, 200, authorized ? {
        ok: true,
        network,
        details,
        tor: {
          active: torActive,
          socksProxy: torForwarding.proxyUrl ?? null,
          address: myTorOnionHost ?? undefined,
          details: torStatus?.state,
        },
      } : { ok: true, network: torActive ? "tor" : "none" });

      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/address") {
      sendJson(res, 200, {
        ok: true,
        torOnion: myTorOnionHost ?? undefined,
        details: myTorOnionHost ? undefined : "address-unavailable",
      });

      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/send") {
      const parsed = await readBody(req);

      if (!parsed.ok || !parsed.body) {
        sendJson(res, parsed.error === "body-too-large" ? 413 : 400, {
          ok: false,
          error: parsed.error ?? "invalid-body",
        });

        return;
      }

      let payload: OnionSendPayload;

      try {
        payload = JSON.parse(parsed.body.toString("utf8")) as OnionSendPayload;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid-json" });

        return;
      }

      const result = await send(payload);
      sendJson(res, result.status, result.body);

      return;
    }

    if (req.method === "GET" && url.pathname === "/onion/inbox") {
      const deviceId = url.searchParams.get("deviceId") ?? "";

      if (!deviceId) {
        sendJson(res, 400, { ok: false, items: [], nextAfter: null, error: "missing-device" });

        return;
      }

      if (!mailboxCapabilities.has(deviceId)) {
        sendJson(res, 403, {
          ok: false,
          items: [],
          nextAfter: null,
          error: "mailbox-not-registered",
        });

        return;
      }

      const expectedCapability = mailboxCapabilities.get(deviceId) ?? "";

      if (!mailboxOwners.has(deviceId) && !ephemeralMailboxes.has(deviceId)) {
        sendJson(res, 403, { ok: false, items: [], nextAfter: null, error: "mailbox-owner-unbound" });

        return;
      }

      const suppliedCapability =
        typeof req.headers["x-nkc-mailbox-token"] === "string"
          ? req.headers["x-nkc-mailbox-token"]
          : "";

      if (
        !suppliedCapability ||
        !matchesMailboxCapability(expectedCapability, suppliedCapability)
      ) {
        sendJson(res, 403, {
          ok: false,
          items: [],
          nextAfter: null,
          error: "mailbox-read-capability-required",
        });

        return;
      }

      const afterRaw = url.searchParams.get("after");
      const scanRaw = url.searchParams.get("scanAfter");
      const scanIndex = scanRaw === null ? null : Number(scanRaw);

      if (scanIndex !== null && (!Number.isSafeInteger(scanIndex) || scanIndex < -1 || afterRaw !== null)) {
        sendJson(res, 400, { ok: false, error: "invalid-inbox-scan", items: [], nextAfter: null });

        return;
      }

      const afterIndex = afterRaw ? Number.parseInt(afterRaw, 10) : -1;
      const limitRaw = url.searchParams.get("limit");
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
      const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 50;

      const state = inbox.get(deviceId) ?? {
        baseIndex: 0,
        bytes: 0,
        legacyBytes: 0,
        legacyItems: 0,
        items: [],
      };

      if (state.items.some(item => item.envelope instanceof Uint8Array)) {
        sendJson(res, 409, { ok: false, items: [], nextAfter: null, error: "binary-inbox-requires-owned-ipc" });

        return;
      }

      if (Number.isFinite(afterIndex) && afterIndex >= state.baseIndex) {
        const end = state.items.findIndex(item => item.index > afterIndex);
        removeItems(state, end < 0 ? state.items.length : end);
      }

      const slice = (scanIndex === null ? state.items : state.items.filter(item => item.index > scanIndex)).slice(0, limit);

      const items = slice.map((item) => ({
        id: item.id,
        ts: item.ts,
        from: item.from,
        envelope: item.envelope,
        expiresAt: item.expiresAt,
        admission: item.admission,
      }));

      const nextAfter =
        slice.length > 0 ? String(slice[slice.length - 1].index) : afterRaw ?? null;

      sendJson(res, 200, { ok: true, items, nextAfter });

      return;
    }

    if (req.method === "POST" && url.pathname === "/onion/ingest") {
      // Only a route/status counter leaves this boundary. Never log request IDs,
      // addresses, mailbox capabilities or the encrypted envelope.
      countSessionStage("controller-ingest", "input");
      cold.mark("controller.ingest.received");

      const sendIngestResult = (status: number, payload: unknown) => {
        countSessionStage("controller-ingest", status === 200 ? "success" : "rejected");
        cold.mark("controller.ingest.result", { outcome: status === 200 ? "ok" : "failed", httpStatus: status });
        sendJson(res, status, payload);
      };

      const now = Date.now();

      if (now - ingestWindowStartedAt >= INGEST_RATE_WINDOW_MS) {
        ingestWindowStartedAt = now;
        ingestWindowCount = 0;
      }

      ingestWindowCount += 1;

      if (ingestWindowCount > MAX_INGESTS_PER_WINDOW) {
        sendIngestResult(429, { ok: false, error: "ingest-rate-limited" });

        return;
      }

      const bodyStartedAt = performance.now();
      const parsed = await readBody(req);
      const requestBodyMs = performance.now() - bodyStartedAt;
      const admissionStartedAt = performance.now();

      if (!parsed.ok || !parsed.body) {
        sendIngestResult(parsed.error === "body-too-large" ? 413 : 400, {
          ok: false,
          error: parsed.error ?? "invalid-body",
        });

        return;
      }

      let payload: {
        toDeviceId?: string;
        from?: string;
        envelope?: string | Uint8Array;
        ts?: number;
        id?: string;
        inboxWriteToken?: string;
      };

      try {
        if (req.headers["content-type"] === "application/vnd.nkc.packet-v2") {
          decodeBinaryTransportPacketV2(parsed.body);
          const id = req.headers["x-nkc-transport-id"];

          if (id !== ownedBinaryRetryId(parsed.body)) throw new Error("INVALID_BINARY_RETRY_ID");
          payload = { id, envelope: parsed.body,
            toDeviceId: typeof req.headers["x-nkc-to-device"] === "string" ? decodeURIComponent(req.headers["x-nkc-to-device"]) : "",
            inboxWriteToken: typeof req.headers["x-nkc-mailbox-token"] === "string" ? req.headers["x-nkc-mailbox-token"] : "" };
        } else {
          payload = JSON.parse(parsed.body.toString("utf8"));
        }
      } catch {
        sendIngestResult(400, { ok: false, error: req.headers["content-type"] === "application/vnd.nkc.packet-v2" ? "invalid-binary-packet" : "invalid-json" });

        return;
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.toDeviceId !== "string" ||
        !payload.toDeviceId ||
        payload.toDeviceId.length > 256 ||
        !(typeof payload.envelope === "string" || payload.envelope instanceof Uint8Array) ||
        !payload.envelope ||
        (payload.from !== undefined &&
          (typeof payload.from !== "string" || payload.from.length > 256)) ||
        (payload.id !== undefined &&
          (typeof payload.id !== "string" || !payload.id || payload.id.length > 128))
      ) {
        sendIngestResult(400, { ok: false, error: "missing-fields" });

        return;
      }

      const diagnosticTiming = () => ({ requestBodyMs, requestBytes: Buffer.byteLength(parsed.body!),
        admissionMs: performance.now() - admissionStartedAt });

      try { if (typeof payload.envelope === "string") options?.onInboundDiagnostic?.(payload.envelope, "controller_received", diagnosticTiming()); } catch { /* Passive observation only. */ }

      const msgId = payload.id ?? randomUUID();
      const ts = Date.now();
      const expectedCapability = mailboxCapabilities.get(payload.toDeviceId);

      if (!expectedCapability) {
        sendIngestResult(404, { ok: false, error: "unknown-mailbox" });

        return;
      }

      if (!mailboxOwners.has(payload.toDeviceId) && !ephemeralMailboxes.has(payload.toDeviceId)) {
        sendIngestResult(409, { ok: false, error: "mailbox-owner-unbound" });

        return;
      }

      const suppliedCapability =
        typeof payload.inboxWriteToken === "string" ? payload.inboxWriteToken : "";

      if (
        (payload.envelope instanceof Uint8Array || suppliedCapability) &&
        !matchesMailboxCapability(expectedCapability, suppliedCapability)
      ) {
        sendIngestResult(401, { ok: false, error: "invalid-mailbox-capability" });

        return;
      }

      const deliveryDeviceId = persistentMailboxAliases.get(payload.toDeviceId) ?? payload.toDeviceId;

      const accepted = enqueue(deliveryDeviceId, {
        id: msgId,
        ts,
        from: payload.from ?? "",
        envelope: payload.envelope,
        admission: suppliedCapability ? "authenticated" : "legacy",
      });

      countSessionStage("inbox-store", accepted ? "success" : "rejected");

      if (!accepted) {
        sendIngestResult(429, { ok: false, error: "inbox-capacity-exceeded" });

        return;
      }

      try { if (typeof payload.envelope === "string") options?.onInboundDiagnostic?.(payload.envelope, "controller_accepted", diagnosticTiming()); } catch { /* Acceptance is not application storage. */ }

      sendIngestResult(200, { ok: true, msgId });

      return;
    }

    sendJson(res, 404, { ok: false, error: "not-found" });
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        cold.mark("controller.listen.ready");
        resolve();
      });
    });
  } catch (error) {
    clearInterval(cleanupTimer);
    throw error;
  }

  const address = server.address();

  const assignedPort =
    typeof address === "object" && address && "port" in address ? address.port : port;

  const baseUrl = `http://${host}:${assignedPort}`;

  return {
    send,
    readInboxItems: (deviceId, token, scanAfter, limit, owner) => {
      owner.assertCurrent();

      if (mailboxOwners.get(deviceId) !== owner.accountId || !token ||
          !matchesMailboxCapability(mailboxCapabilities.get(deviceId) ?? "", token) ||
          !Number.isSafeInteger(scanAfter) || scanAfter < -1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        return { ok: false, items: [], nextAfter: null, error: "invalid-owned-inbox-read" };
      }

      const items: InboxItem[] = [];
      let bytes = 0;

      for (const item of inbox.get(deviceId)?.items ?? []) {
        if (item.index <= scanAfter) continue;
        const itemBytes = getItemBytes(item);

        if (items.length >= limit || bytes + itemBytes > MAX_BODY_BYTES) break;
        bytes += itemBytes;
        items.push({ ...item, envelope: typeof item.envelope === "string" ? item.envelope : new Uint8Array(item.envelope) });
      }

      return { ok: true, items, nextAfter: items.length ? String(items[items.length - 1].index) : null };
    },
    acknowledgeInboxItems: (deviceId, itemIds, owner) => {
      if (!Array.isArray(itemIds) || itemIds.length > 100 ||
          itemIds.some(id => typeof id !== "string" || !id || id.length > 256) ||
          mailboxOwners.get(deviceId) !== owner.accountId) return false;
      owner.assertCurrent();
      const state = inbox.get(deviceId);

      if (!state) return true;
      const completed = new Set(itemIds);

      // Remove only completed items. Stable indices preserve the existing prefix reader contract.
      for (let index = state.items.length - 1; index >= 0; index--) {
        if (completed.has(state.items[index].id)) removeItems(state, 1, index);
      }

      return true;
    },
    baseUrl,
    port: assignedPort,
    authToken,
    setTorSocksProxy,
    setTorSocksProxies,
    setTorOnionHost,
    prewarmTorRoute,
    registerMailbox,
    getMailboxOwner: (deviceId) => mailboxOwners.get(deviceId),
    hasRetainedInboxItem: (deviceId, operationId) => Boolean(mailboxOwners.has(deviceId) &&
      inbox.get(deviceId)?.items.some(item => item.id === operationId && item.admission === "authenticated" && item.expiresAt > Date.now())),
    unregisterMailbox,
    close: async () => {
      closing = true;
      clearInterval(cleanupTimer);
      await Promise.all(torForwarding.proxyUrls.map((proxyUrl) => socksTransport.clearProxy(proxyUrl)));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Application exit cannot wait indefinitely for a local HTTP upload or poll.
        // Terminated requests receive no successful delivery acknowledgement.
        server.closeAllConnections();
      });
    },
  };
};
