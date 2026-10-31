import type { NativeWorkerClient } from "./nativeWorkerClient";
import { coldStartTelemetry as cold } from "./coldStartTelemetry";
import { getTorProbeErrorCode, probeNetworkStages } from "./torProbeError";

export type P2PFriendRoute = { friendId: string; onionAddress: string };

export type P2PQueuedMessage = {
  accountId: string;
  id: string;
  friendId: string;
  onionAddress: string;
  payload: string;
  status: "PENDING" | "IN_FLIGHT" | "DELIVERED" | "FAILED";
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  lastError?: string;
  attempts?: number;
  nextAttemptAt?: number;
  failedAt?: number;
};

export type OfflineQueueManager = {
  start: () => void;
  stop: () => void;
  updateProxyUrl: (value: string | null, waitForWake?: boolean) => Promise<void>;
  getActiveAccountId: () => string;
  setActiveAccount: (accountId: string, assertCurrent?: () => void, sessionToken?: string) => Promise<void>;
  removeAccount: (accountId: string, assertCurrent?: () => void) => Promise<void>;
  clearPending: (accountId?: string, assertCurrent?: () => void) => Promise<number>;
  setFriends: (accountId: string, friends: P2PFriendRoute[], assertCurrent?: () => void) => Promise<void>;
  enqueueMessage: (input: {
    accountId?: string;
    sessionToken?: string;
    immutable?: boolean;
    inboxWriteToken?: string;
    friendId: string;
    onionAddress: string;
    payload: string;
    id?: string;
    createdAt?: number;
  }, assertCurrent?: () => void) => Promise<P2PQueuedMessage>;
  listMessages: (accountId?: string, assertCurrent?: () => void) => Promise<P2PQueuedMessage[]>;
  flushNow: (accountId?: string, assertCurrent?: () => void) => Promise<void>;
};

export class NativeOfflineQueueManager implements OfflineQueueManager {
  private readonly client: NativeWorkerClient;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pendingStateWake = false;
  private lifecycle = 0;
  private lastSyncedProxy = "";
  private activeAccountId = "legacy";
  private diagnosisFinished = false;
  private diagnosedId: string | null = null;
  private readonly diagnoseFirstQueueId?: () => string | null;
  private readonly diagnoseKind?: () => "chat" | "friend" | undefined;

  private constructor(client: NativeWorkerClient, intervalMs: number, diagnoseFirstQueueId?: () => string | null, diagnoseKind?: () => "chat" | "friend" | undefined) {
    this.client = client;
    this.intervalMs = intervalMs;
    this.diagnoseFirstQueueId = diagnoseFirstQueueId;
    this.diagnoseKind = diagnoseKind;
  }

  static async create(
    client: NativeWorkerClient,
    dbPath: string,
    legacySnapshot: string,
    intervalMs = 10_000,
    diagnoseFirstQueueId?: () => string | null,
    diagnoseKind?: () => "chat" | "friend" | undefined
  ) {
    await client.request("queue.init", {
      path: dbPath,
      legacySnapshot,
      legacyJournal: `${legacySnapshot}.journal`,
    });

    return new NativeOfflineQueueManager(client, intervalMs, diagnoseFirstQueueId, diagnoseKind);
  }

  start() {
    if (this.timer) return;
    this.lifecycle++;
    this.schedule(0);
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.lifecycle++;
    this.pendingStateWake = false;
  }

  updateProxyUrl(value: string | null, waitForWake = true) {
    const proxyUrl = value?.trim() ?? "";

    return this.client
      .request("queue.setProxy", { proxyUrl })
      .then(() => {
        const changed = this.lastSyncedProxy !== proxyUrl;
        this.lastSyncedProxy = proxyUrl;

        if (proxyUrl && this.timer && (changed || !this.stateWakeExperimentEnabled())) {
          const wake = this.wakeForStateChange();

          if (waitForWake) return wake;
          // Test-only proxy synchronization must not be blocked by the existing flush.
          void wake.catch((error) => console.warn("[native-queue] proxy wake failed", error));
        }
      })
      .catch((error) => console.warn("[native-queue] failed to update proxy", error));
  }

  getActiveAccountId() {
    return this.activeAccountId;
  }

  async setActiveAccount(accountId: string, assertCurrent?: () => void, sessionToken?: string) {
    assertCurrent?.();
    await this.client.request("queue.setActiveAccount", { accountId, ...(sessionToken ? { sessionToken } : {}) });
    assertCurrent?.();
    const changed = this.activeAccountId !== accountId;
    this.activeAccountId = accountId;

    if (this.timer && (changed || !this.stateWakeExperimentEnabled())) void this.wakeForStateChange().catch((error) => console.warn("[native-queue] account wake failed", error));
  }

  async removeAccount(accountId: string, assertCurrent?: () => void) {
    assertCurrent?.();
    await this.client.request("queue.removeAccount", { accountId });
  }

  async clearPending(accountId = this.activeAccountId, assertCurrent?: () => void) {
    assertCurrent?.();
    const result = await this.client.request<{ removed: number }>("queue.clearPending", {
      accountId,
    });

    return result.removed;
  }

  async setFriends(accountId: string, friends: P2PFriendRoute[], assertCurrent?: () => void) {
    assertCurrent?.();
    await this.client.request("queue.setFriends", { accountId, friends });
  }

  enqueueMessage(input: {
    accountId?: string;
    sessionToken?: string;
    immutable?: boolean;
    inboxWriteToken?: string;
    friendId: string;
    onionAddress: string;
    payload: string;
    id?: string;
    createdAt?: number;
  }, assertCurrent?: () => void) {
    assertCurrent?.();
    return this.client.request<P2PQueuedMessage>("queue.enqueue", {
      ...input,
      accountId: input.accountId ?? this.activeAccountId,
    });
  }

  listMessages(accountId = this.activeAccountId, assertCurrent?: () => void) {
    assertCurrent?.();
    return this.client.request<P2PQueuedMessage[]>("queue.list", { accountId });
  }

  async flushNow(accountId = this.activeAccountId, assertCurrent?: () => void) {
    assertCurrent?.();
    if (this.running) return;
    this.running = true;

    try {
      const selectedId = process.env.NKC_COLD_START_TRACE === "1" ? this.diagnoseFirstQueueId?.() ?? null : null;

      if (selectedId !== this.diagnosedId) { this.diagnosedId = selectedId; this.diagnosisFinished = false; }

      const diagnoseId = !this.diagnosisFinished ? selectedId : null;
      const messageKind = this.diagnoseKind?.();

      if (diagnoseId) cold.mark("p2p.queue.flush.begin", { messageKind });

      const result = await this.client.request<{ diagnostic?: Record<string, unknown> }>("queue.flush", {
        accountId,
        // Same budget as the foreground forward (onionController FORWARD_TIMEOUT_MS, transport.go connect):
        // a queued 1 MiB chunk retried with 10 s could never finish a slow Tor upload.
        connectTimeoutMs: 45_000,
        ackTimeoutMs: 45_000,
        ...(diagnoseId ? { diagnoseId } : {}),
      }, 120_000);

      if (diagnoseId && result?.diagnostic) {
        const detail = result.diagnostic;

        if (detail.state === "delivered" || detail.state === "failed") this.diagnosisFinished = true;

        const queueState = (["not_observed", "flush_busy", "pending", "in_flight", "failed", "delivered", "retry_started", "proxy_unavailable"] as const)
          .find((state) => state === detail.state);

        cold.mark("p2p.queue.flush", {
          messageKind, queueState, attempt: numberOrUndefined(detail.attempts), dueInMs: numberOrUndefined(detail.dueInMs),
          queueAgeMs: numberOrUndefined(detail.queueAgeMs), priorAttempts: numberOrUndefined(detail.priorAttempts),
          priorNetworkMs: numberOrUndefined(detail.priorNetworkMs),
        });

        if (detail.retryStarted === true) {
          cold.mark("p2p.queue.retry_result", {
            messageKind, queueState, attempt: numberOrUndefined(detail.attempts),
            priorAttempts: numberOrUndefined(detail.priorAttempts), priorNetworkMs: numberOrUndefined(detail.priorNetworkMs),
            retryStartMs: numberOrUndefined(detail.retryStartMs), dueLatenessMs: numberOrUndefined(detail.dueLatenessMs),
            attemptDurationMs: numberOrUndefined(detail.attemptDurationMs),
            socksDurationMs: numberOrUndefined(detail.socksDurationMs),
            socksStarted: detail.socksStarted === true,
            connectionReused: detail.connectionReused === true,
            nextDueInMs: numberOrUndefined(detail.nextDueInMs),
            networkStage: probeNetworkStages.find((stage) => stage === detail.networkStage),
            errorCode: detail.delivered === true ? undefined : getTorProbeErrorCode(detail.errorCode),
            httpStatus: numberOrUndefined(detail.httpStatus),
            outcome: detail.delivered === true ? "ok" : "failed",
          });
        }
      }
    } finally {
      this.running = false;

      if (this.pendingStateWake && this.timer) {
        this.pendingStateWake = false;
        const lifecycle = this.lifecycle;
        queueMicrotask(() => {
          if (this.timer && this.lifecycle === lifecycle) void this.flushNow().catch((error) => console.warn("[native-queue] state wake failed", error));
        });
      }
    }
  }

  private wakeForStateChange() {
    // A changed proxy/account makes the worker abandon the previous snapshot.
    // Keep one wake for disposable experiments, without changing production retry cadence.
    if (this.running && this.stateWakeExperimentEnabled()) {
      this.pendingStateWake = true;

      return Promise.resolve();
    }

    return this.flushNow();
  }

  private stateWakeExperimentEnabled() {
    return Boolean(process.env.NKC_E2E_USER_DATA_DIR) && process.env.NKC_TEST_QUEUE_PRESERVE_WAKE === "1";
  }

  private schedule(delayMs: number) {
    const lifecycle = this.lifecycle;
    this.timer = setTimeout(() => {
      void this.flushNow()
        .catch((error) => console.warn("[native-queue] flush failed", error))
        .finally(() => {
          if (this.timer && this.lifecycle === lifecycle) this.schedule(this.intervalMs);
        });
    }, delayMs);
  }
}

const numberOrUndefined = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
