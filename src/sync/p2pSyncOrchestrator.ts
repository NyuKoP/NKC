import type { OutboxRecord } from "../db/schema";
import {
  SecureStorageKeyring,
  createSecureOutboxStore,
  type SecureStoredRecord,
  type SecureTableLike,
} from "../db/secureStorage";
import {
  ConnectionManager,
  type ConnectionManagerState,
  type ManagedConnection,
} from "./connectionManager";
import {
  handleIncomingSyncFrame,
  setSyncTransportOverride,
  syncConversation,
} from "./syncEngine";

export type P2PSyncRoute = {
  convId: string;
  connect: () => Promise<ManagedConnection>;
};

export type P2PSyncEngineBridge = {
  handleIncoming: (convId: string, bytes: Uint8Array) => Promise<void> | void;
  syncConversation: (convId: string) => Promise<void> | void;
  bindOutbound: (
    send: (convId: string, bytes: Uint8Array) => Promise<void>
  ) => (() => void) | void;
  reset?: () => void;
};

export type P2POutboxTable = SecureTableLike<SecureStoredRecord> & {
  delete?: (id: string) => Promise<unknown> | unknown;
  update?: (id: string, patch: Partial<SecureStoredRecord>) => Promise<unknown> | unknown;
};

export type P2PSyncOrchestratorOptions = {
  keyring: SecureStorageKeyring;
  outboxTable: P2POutboxTable;
  syncEngine?: P2PSyncEngineBridge;
  maxFlushBatch?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  onStateChange?: (convId: string, state: ConnectionManagerState, detail?: string) => void;
};

type ManagedConversation = {
  route: P2PSyncRoute;
  manager: ConnectionManager;
};

const textEncoder = new TextEncoder();
const DEFAULT_FLUSH_BATCH = 10;
const DEFAULT_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const defaultSyncEngineBridge: P2PSyncEngineBridge = {
  handleIncoming: handleIncomingSyncFrame,
  syncConversation,
  bindOutbound: (send) => setSyncTransportOverride({ send }),
};

const getExpiresAt = (record: OutboxRecord) => {
  if (typeof record.expiresAtMs === "number") return record.expiresAtMs;
  const createdAt = record.createdAt ?? record.createdAtMs ?? 0;
  const ttlMs = record.ttlMs ?? DEFAULT_OUTBOX_TTL_MS;
  return createdAt + ttlMs;
};

const getNextAttemptAt = (record: OutboxRecord) =>
  record.nextAttemptAt ?? record.nextAttemptAtMs ?? record.createdAt ?? record.createdAtMs ?? 0;

const getAttempt = (record: OutboxRecord) => record.attempt ?? record.attempts ?? 0;

export class P2PSyncOrchestrator {
  private readonly keyring: SecureStorageKeyring;
  private readonly outboxStore: ReturnType<typeof createSecureOutboxStore>;
  private readonly outboxTable: P2POutboxTable;
  private readonly syncEngine: P2PSyncEngineBridge;
  private readonly maxFlushBatch: number;
  private readonly heartbeatIntervalMs?: number;
  private readonly pongTimeoutMs?: number;
  private readonly maxBackoffMs?: number;
  private readonly now: () => number;
  private readonly onStateChange?: P2PSyncOrchestratorOptions["onStateChange"];
  private readonly conversations = new Map<string, ManagedConversation>();
  private active = false;
  private unbindOutbound: (() => void) | null = null;

  constructor(options: P2PSyncOrchestratorOptions) {
    this.keyring = options.keyring;
    this.outboxStore = createSecureOutboxStore(options.keyring);
    this.outboxTable = options.outboxTable;
    this.syncEngine = options.syncEngine ?? defaultSyncEngineBridge;
    this.maxFlushBatch = options.maxFlushBatch ?? DEFAULT_FLUSH_BATCH;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.pongTimeoutMs = options.pongTimeoutMs;
    this.maxBackoffMs = options.maxBackoffMs;
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
  }

  isActive() {
    return this.active;
  }

  async activate(routes: P2PSyncRoute[] = []) {
    if (!this.keyring.isUnlocked()) {
      throw new Error("p2p_orchestrator_locked");
    }
    if (!this.active) {
      this.active = true;
      this.unbindOutbound = this.syncEngine.bindOutbound((convId, bytes) =>
        this.send(convId, bytes)
      ) ?? null;
    }
    await Promise.all(routes.map((route) => this.registerConversation(route)));
  }

  async registerConversation(route: P2PSyncRoute) {
    if (!this.keyring.isUnlocked()) {
      throw new Error("p2p_orchestrator_locked");
    }
    const existing = this.conversations.get(route.convId);
    if (existing) {
      existing.route = route;
      return existing.manager;
    }
    const manager = new ConnectionManager({
      convId: route.convId,
      connect: route.connect,
      hasPendingOutbox: (convId) => this.hasPendingOutbox(convId),
      flushOutbox: (convId) => this.flushOutbox(convId),
      onData: (bytes) => this.syncEngine.handleIncoming(route.convId, bytes),
      onStateChange: (state, detail) => this.onStateChange?.(route.convId, state, detail),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      pongTimeoutMs: this.pongTimeoutMs,
      maxBackoffMs: this.maxBackoffMs,
      now: this.now,
    });
    this.conversations.set(route.convId, { route, manager });
    if (this.active) {
      await manager.start();
    }
    return manager;
  }

  async startConversation(convId: string) {
    const entry = this.conversations.get(convId);
    if (!entry) throw new Error("conversation_not_registered");
    await entry.manager.start();
  }

  async send(convId: string, bytes: Uint8Array) {
    const entry = this.conversations.get(convId);
    if (!entry) throw new Error("conversation_not_registered");
    await entry.manager.send(bytes);
  }

  async syncNow(convId: string) {
    await this.syncEngine.syncConversation(convId);
  }

  async flushOutbox(convId: string) {
    const entry = this.conversations.get(convId);
    if (!entry) return;
    const due = await this.listDueOutbox(convId);
    for (const record of due) {
      try {
        await entry.manager.send(textEncoder.encode(record.ciphertext));
        await this.deleteOutboxRecord(record.id);
      } catch (error) {
        await this.markOutboxRetry(
          record,
          error instanceof Error ? error.message : String(error)
        );
        break;
      }
    }
  }

  async shutdown() {
    this.active = false;
    const managers = Array.from(this.conversations.values()).map((entry) => entry.manager);
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(managers.map((manager) => manager.stop()));
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      try {
        this.unbindOutbound?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.syncEngine.reset?.();
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.conversations.clear();
      this.unbindOutbound = null;
      this.keyring.clear();
    }
    if (errors.length > 0) {
      throw new Error("p2p_orchestrator_shutdown_failed", { cause: errors });
    }
  }

  private async hasPendingOutbox(convId: string) {
    return (await this.listDueOutbox(convId, 1)).length > 0;
  }

  private async listDueOutbox(convId: string, limit = this.maxFlushBatch) {
    const now = this.now();
    const all = await this.outboxStore.getAll(this.outboxTable);
    return all
      .filter((record) => {
        if (record.convId !== convId) return false;
        if (record.status !== "pending" && record.status !== "in_flight") return false;
        if (!record.ciphertext) return false;
        if (getExpiresAt(record) <= now) return false;
        return getNextAttemptAt(record) <= now;
      })
      .sort((lhs, rhs) => {
        const nextDelta = getNextAttemptAt(lhs) - getNextAttemptAt(rhs);
        if (nextDelta !== 0) return nextDelta;
        return (lhs.createdAtMs ?? lhs.createdAt ?? 0) - (rhs.createdAtMs ?? rhs.createdAt ?? 0);
      })
      .slice(0, limit);
  }

  private async deleteOutboxRecord(id: string) {
    if (this.outboxTable.delete) {
      await this.outboxTable.delete(id);
    } else if (this.outboxTable.update) {
      await this.outboxTable.update(id, { status: "acked" });
    }
  }

  private async markOutboxRetry(record: OutboxRecord, error: string) {
    if (!this.outboxTable.update) return;
    const attempt = getAttempt(record) + 1;
    const nextAttemptAt = this.now() + Math.min(2 ** attempt * 1000, 60_000);
    const encrypted = await this.outboxStore.encryptRecord({
      ...record,
      attempt,
      attempts: attempt,
      nextAttemptAt,
      nextAttemptAtMs: nextAttemptAt,
      lastError: error,
      status: "pending",
    });
    await this.outboxTable.put(encrypted);
  }
}
