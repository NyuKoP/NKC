import type { NativeWorkerClient } from "./nativeWorkerClient";

export type P2PFriendRoute = { friendId: string; onionAddress: string };
export type P2PQueuedMessage = {
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
  updateProxyUrl: (value: string | null) => void;
  setFriends: (friends: P2PFriendRoute[]) => Promise<void>;
  enqueueMessage: (input: {
    friendId: string;
    onionAddress: string;
    payload: string;
    id?: string;
    createdAt?: number;
  }) => Promise<P2PQueuedMessage>;
  listMessages: () => Promise<P2PQueuedMessage[]>;
  flushNow: () => Promise<void>;
};

export class NativeOfflineQueueManager implements OfflineQueueManager {
  private readonly client: NativeWorkerClient;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private constructor(client: NativeWorkerClient, intervalMs: number) {
    this.client = client;
    this.intervalMs = intervalMs;
  }

  static async create(
    client: NativeWorkerClient,
    dbPath: string,
    legacySnapshot: string,
    intervalMs = 10_000
  ) {
    await client.request("queue.init", {
      path: dbPath,
      legacySnapshot,
      legacyJournal: `${legacySnapshot}.journal`,
    });
    return new NativeOfflineQueueManager(client, intervalMs);
  }

  start() {
    if (this.timer) return;
    this.schedule(0);
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  updateProxyUrl(value: string | null) {
    void this.client
      .request("queue.setProxy", { proxyUrl: value?.trim() ?? "" })
      .catch((error) => console.warn("[native-queue] failed to update proxy", error));
  }

  async setFriends(friends: P2PFriendRoute[]) {
    await this.client.request("queue.setFriends", { friends });
  }

  enqueueMessage(input: {
    friendId: string;
    onionAddress: string;
    payload: string;
    id?: string;
    createdAt?: number;
  }) {
    return this.client.request<P2PQueuedMessage>("queue.enqueue", input);
  }

  listMessages() {
    return this.client.request<P2PQueuedMessage[]>("queue.list", {});
  }

  async flushNow() {
    if (this.running) return;
    this.running = true;
    try {
      await this.client.request("queue.flush", {
        connectTimeoutMs: 8_000,
        ackTimeoutMs: 10_000,
      }, 120_000);
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      void this.flushNow()
        .catch((error) => console.warn("[native-queue] flush failed", error))
        .finally(() => {
          if (this.timer) this.schedule(this.intervalMs);
        });
    }, delayMs);
  }
}
