import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type P2PQueuedMessageStatus = "PENDING" | "IN_FLIGHT" | "DELIVERED";

export type P2PFriendRoute = {
  friendId: string;
  onionAddress: string;
};

export type P2PQueuedMessage = {
  id: string;
  friendId: string;
  onionAddress: string;
  payload: string;
  status: P2PQueuedMessageStatus;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  lastError?: string;
};

type QueueFile = {
  friends: P2PFriendRoute[];
  messages: P2PQueuedMessage[];
};

type QueueJournalEntry =
  | { v: 1; op: "base"; queue: QueueFile }
  | { v: 1; op: "replaceFriends"; friends: P2PFriendRoute[] }
  | { v: 1; op: "upsertMessage"; message: P2PQueuedMessage; friend?: P2PFriendRoute }
  | {
      v: 1;
      op: "patchMessages";
      ids: string[];
      patch: Partial<Pick<P2PQueuedMessage, "status" | "updatedAt" | "deliveredAt" | "lastError">>;
    }
  | {
      v: 1;
      op: "resetFriend";
      friendId: string;
      updatedAt: number;
      lastError: string;
    };

export type P2POfflineQueueManagerOptions = {
  dbPath: string;
  getTorSocksProxy: () => string | null;
  intervalMs?: number;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  connect?: typeof connectViaSocks5;
  now?: () => number;
  uuid?: () => string;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

type SocketLike = net.Socket;

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const ONION_VIRTUAL_PORT = 80;
const MAX_FRAME_BYTES = 256 * 1024;
const JOURNAL_COMPACT_AFTER_ENTRIES = 512;

const emptyQueue = (): QueueFile => ({ friends: [], messages: [] });

const isQueueFile = (value: unknown): value is QueueFile => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueueFile>;
  return Array.isArray(candidate.friends) && Array.isArray(candidate.messages);
};

const applyJournalEntry = (queue: QueueFile, entry: QueueJournalEntry) => {
  if (entry.op === "base") {
    queue.friends = entry.queue.friends;
    queue.messages = entry.queue.messages;
    return;
  }
  if (entry.op === "replaceFriends") {
    queue.friends = entry.friends;
    return;
  }
  if (entry.op === "upsertMessage") {
    if (entry.friend) {
      const friendIndex = queue.friends.findIndex(
        (friend) => friend.friendId === entry.friend?.friendId
      );
      if (friendIndex === -1) queue.friends.push(entry.friend);
      else queue.friends[friendIndex] = entry.friend;
    }
    const messageIndex = queue.messages.findIndex((message) => message.id === entry.message.id);
    if (messageIndex === -1) queue.messages.push(entry.message);
    else queue.messages[messageIndex] = entry.message;
    return;
  }
  if (entry.op === "patchMessages") {
    const ids = new Set(entry.ids);
    queue.messages.forEach((message) => {
      if (!ids.has(message.id)) return;
      Object.assign(message, entry.patch);
      if (entry.patch.lastError === undefined) delete message.lastError;
    });
    return;
  }
  if (entry.op === "resetFriend") {
    queue.messages.forEach((message) => {
      if (message.friendId !== entry.friendId || message.status !== "IN_FLIGHT") return;
      message.status = "PENDING";
      message.updatedAt = entry.updatedAt;
      message.lastError = entry.lastError;
    });
  }
};

const normalizeOnionAddress = (value: string) =>
  value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

const parseSocksProxy = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("unsupported_socks_protocol");
  }
  const port = Number(url.port || "0");
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid_socks_proxy");
  }
  return { host: url.hostname, port };
};

const readExactly = (socket: SocketLike, size: number) =>
  new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onData = (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      if (buffered.length >= size) {
        cleanup();
        resolve(buffered.subarray(0, size));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket_closed"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });

export const connectViaSocks5 = async (
  socksProxyUrl: string,
  targetHost: string,
  targetPort = ONION_VIRTUAL_PORT,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
) => {
  const proxy = parseSocksProxy(socksProxyUrl);
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  const timeout = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const method = await readExactly(socket, 2);
    if (method[0] !== 0x05 || method[1] !== 0x00) {
      throw new Error("socks_auth_failed");
    }

    const host = Buffer.from(targetHost, "utf8");
    if (host.length > 255) throw new Error("target_host_too_long");
    const port = Buffer.alloc(2);
    port.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

    const head = await readExactly(socket, 4);
    if (head[0] !== 0x05 || head[1] !== 0x00) {
      throw new Error("socks_connect_failed");
    }
    if (head[3] === 0x01) {
      await readExactly(socket, 4);
    } else if (head[3] === 0x03) {
      const len = await readExactly(socket, 1);
      await readExactly(socket, len[0]);
    } else if (head[3] === 0x04) {
      await readExactly(socket, 16);
    } else {
      throw new Error("socks_connect_failed");
    }
    await readExactly(socket, 2);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const writeFrame = (socket: SocketLike, payload: unknown) => {
  socket.write(`${JSON.stringify(payload)}\n`);
};

class JsonFrameReader {
  private readonly socket: SocketLike;
  private buffered = "";
  private closedError: Error | null = null;
  private pending:
    | {
        resolve: (value: Record<string, unknown>) => void;
        reject: (reason?: unknown) => void;
        timeout: NodeJS.Timeout;
      }
    | null = null;

  constructor(socket: SocketLike) {
    this.socket = socket;
    this.socket.on("data", this.onData);
    this.socket.once("error", this.onError);
    this.socket.once("end", this.onEnd);
  }

  read(timeoutMs: number) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.pending) {
        reject(new Error("concurrent_frame_read_not_supported"));
        return;
      }
      const timeout = setTimeout(() => {
        this.rejectPending(new Error("ack_timeout"));
      }, timeoutMs);
      this.pending = { resolve, reject, timeout };
      this.resolvePending();
    });
  }

  dispose() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.rejectPending(new Error("reader_disposed"));
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffered += chunk.toString("utf8");
    this.resolvePending();
  };

  private readonly onError = (error: Error) => {
    this.closedError = error;
    this.rejectPending(error);
  };

  private readonly onEnd = () => {
    this.closedError = new Error("socket_closed");
    this.rejectPending(this.closedError);
  };

  private resolvePending() {
    if (!this.pending) return;
    if (Buffer.byteLength(this.buffered, "utf8") > MAX_FRAME_BYTES) {
      this.rejectPending(new Error("frame_too_large"));
      return;
    }
    const newline = this.buffered.indexOf("\n");
    if (newline !== -1) {
      const raw = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);
      try {
        pending.resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        pending.reject(new Error("invalid_frame"));
      }
      return;
    }
    if (this.closedError) {
      this.rejectPending(this.closedError);
    }
  }

  private rejectPending(error: Error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}

export class P2POfflineQueueManager {
  private readonly dbPath: string;
  private readonly journalPath: string;
  private readonly intervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly connect: typeof connectViaSocks5;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = new Set<string>();
  private writeLock: Promise<void> = Promise.resolve();
  private queuePromise: Promise<QueueFile> | null = null;
  private journalEntryCount = 0;
  private journalHasBase = false;
  private proxyUrl: string | null;

  constructor(options: P2POfflineQueueManagerOptions) {
    this.dbPath = options.dbPath;
    this.journalPath = `${options.dbPath}.journal`;
    this.proxyUrl = options.getTorSocksProxy();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.connect = options.connect ?? connectViaSocks5;
    this.now = options.now ?? (() => Date.now());
    this.uuid = options.uuid ?? (() => randomUUID());
    this.log = options.log;
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

  updateProxyUrl(newProxyUrl: string | null) {
    const trimmed = newProxyUrl?.trim() ?? "";
    this.proxyUrl = trimmed ? trimmed : null;
  }

  async setFriends(friends: P2PFriendRoute[]) {
    await this.withQueue(async (queue) => {
      const byFriendId = new Map(queue.friends.map((friend) => [friend.friendId, friend]));
      for (const friend of friends) {
        const onionAddress = normalizeOnionAddress(friend.onionAddress);
        if (!friend.friendId || !onionAddress.endsWith(".onion")) continue;
        byFriendId.set(friend.friendId, { friendId: friend.friendId, onionAddress });
      }
      return { v: 1, op: "replaceFriends", friends: [...byFriendId.values()] };
    });
  }

  async enqueueMessage(input: {
    friendId: string;
    onionAddress: string;
    payload: string;
    id?: string;
    createdAt?: number;
  }) {
    const now = this.now();
    const onionAddress = normalizeOnionAddress(input.onionAddress);
    if (!input.friendId || !onionAddress.endsWith(".onion")) {
      throw new Error("invalid_friend_onion_route");
    }
    const message: P2PQueuedMessage = {
      id: input.id ?? this.uuid(),
      friendId: input.friendId,
      onionAddress,
      payload: input.payload,
      status: "PENDING",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    await this.withQueue(async (queue) => {
      const friend = queue.friends.some((item) => item.friendId === input.friendId)
        ? undefined
        : { friendId: input.friendId, onionAddress };
      const existing = queue.messages.find((item) => item.id === message.id);
      if (existing) {
        if (existing.status !== "DELIVERED") {
          return {
            v: 1,
            op: "upsertMessage",
            friend,
            message: { ...existing, status: "PENDING", updatedAt: now, lastError: undefined },
          };
        }
        if (friend) {
          return { v: 1, op: "upsertMessage", friend, message: existing };
        }
        return null;
      }
      return { v: 1, op: "upsertMessage", friend, message };
    });
    return message;
  }

  async listMessages() {
    const queue = await this.readQueue();
    return [...queue.messages].sort((a, b) => a.createdAt - b.createdAt);
  }

  async flushNow() {
    if (this.running) return;
    this.running = true;
    try {
      const socksProxy = this.proxyUrl;
      if (!socksProxy) return;
      const queue = await this.readQueue();
      const friends = queue.friends.filter((friend) =>
        queue.messages.some(
          (message) => message.friendId === friend.friendId && message.status === "PENDING"
        )
      );
      for (const friend of friends) {
        await this.flushFriend(friend, socksProxy);
      }
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      void this.flushNow()
        .catch((error) => {
          this.log?.("[p2p-queue] flush failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (this.timer) this.schedule(this.intervalMs);
        });
    }, delayMs);
  }

  private async flushFriend(friend: P2PFriendRoute, socksProxy: string) {
    if (this.inFlight.has(friend.friendId)) return;
    this.inFlight.add(friend.friendId);
    let socket: SocketLike | null = null;
    let reader: JsonFrameReader | null = null;
    try {
      socket = await this.connect(
        socksProxy,
        friend.onionAddress,
        ONION_VIRTUAL_PORT,
        this.connectTimeoutMs
      );
      reader = new JsonFrameReader(socket);
      writeFrame(socket, {
        type: "NKC_P2P_HELLO",
        version: 1,
        friendId: friend.friendId,
        ts: this.now(),
      });
      const helloAck = await reader.read(this.ackTimeoutMs);
      if (helloAck.type !== "NKC_P2P_HELLO_ACK") {
        throw new Error("handshake_failed");
      }

      const pending = (await this.listMessages()).filter(
        (message) => message.friendId === friend.friendId && message.status === "PENDING"
      );
      if (!pending.length) return;
      await this.markInFlight(pending.map((message) => message.id));
      writeFrame(socket, {
        type: "NKC_P2P_PUSH",
        version: 1,
        messages: pending.map((message) => ({
          id: message.id,
          createdAt: message.createdAt,
          payload: message.payload,
        })),
      });
      const ack = await reader.read(this.ackTimeoutMs);
      const ackIds = Array.isArray(ack.messageIds)
        ? ack.messageIds.filter((id): id is string => typeof id === "string")
        : [];
      if (ack.type !== "NKC_P2P_ACK" || !ackIds.length) {
        throw new Error("ack_failed");
      }
      await this.markDelivered(ackIds);
    } catch (error) {
      await this.resetInFlightForFriend(
        friend.friendId,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      reader?.dispose();
      socket?.destroy();
      this.inFlight.delete(friend.friendId);
    }
  }

  private async markInFlight(ids: string[]) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      const targetIds = new Set(ids);
      const eligibleIds = queue.messages
        .filter((message) => targetIds.has(message.id) && message.status === "PENDING")
        .map((message) => message.id);
      if (!eligibleIds.length) return null;
      return {
        v: 1,
        op: "patchMessages",
        ids: eligibleIds,
        patch: { status: "IN_FLIGHT", updatedAt: now, lastError: undefined },
      };
    });
  }

  private async markDelivered(ids: string[]) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      const targetIds = new Set(ids);
      const eligibleIds = queue.messages
        .filter((message) => targetIds.has(message.id))
        .map((message) => message.id);
      if (!eligibleIds.length) return null;
      return {
        v: 1,
        op: "patchMessages",
        ids: eligibleIds,
        patch: {
          status: "DELIVERED",
          updatedAt: now,
          deliveredAt: now,
          lastError: undefined,
        },
      };
    });
  }

  private async resetInFlightForFriend(friendId: string, error: string) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      const hasInFlight = queue.messages.some(
        (message) => message.friendId === friendId && message.status === "IN_FLIGHT"
      );
      if (!hasInFlight) return null;
      return { v: 1, op: "resetFriend", friendId, updatedAt: now, lastError: error };
    });
  }

  private async withQueue(
    createEntry: (
      queue: QueueFile
    ) => Promise<QueueJournalEntry | null> | QueueJournalEntry | null
  ) {
    const nextWrite = this.writeLock.catch(() => undefined).then(async () => {
      const queue = await this.readQueue();
      const entry = await createEntry(queue);
      if (!entry) return;
      await this.appendJournalEntry(queue, entry);
      applyJournalEntry(queue, entry);
      if (this.journalEntryCount >= JOURNAL_COMPACT_AFTER_ENTRIES) {
        await this.compactJournal(queue);
      }
    });
    this.writeLock = nextWrite;
    await nextWrite;
  }

  private async readQueue(): Promise<QueueFile> {
    if (!this.queuePromise) {
      this.queuePromise = this.loadQueue();
    }
    return this.queuePromise;
  }

  private async loadQueue(): Promise<QueueFile> {
    let queue = emptyQueue();
    try {
      const raw = await fs.readFile(this.dbPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isQueueFile(parsed)) queue = parsed;
    } catch (error) {
      if (!this.isMissingFileError(error) && !(error instanceof SyntaxError)) throw error;
    }

    try {
      const journal = await fs.readFile(this.journalPath, "utf8");
      const lines = journal.split("\n");
      const validLines: string[] = [];
      let repairIncompleteTail = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as QueueJournalEntry;
          if (entry?.v !== 1 || typeof entry.op !== "string") continue;
          if (entry.op === "base" && isQueueFile(entry.queue)) this.journalHasBase = true;
          applyJournalEntry(queue, entry);
          this.journalEntryCount += 1;
          validLines.push(line);
        } catch {
          // A process termination can leave only the final append incomplete.
          if (index !== lines.length - 1) throw new Error("invalid_queue_journal");
          repairIncompleteTail = true;
        }
      }
      if (repairIncompleteTail) {
        await fs.writeFile(
          this.journalPath,
          validLines.length ? `${validLines.join("\n")}\n` : "",
          "utf8"
        );
      }
    } catch (error) {
      if (!this.isMissingFileError(error)) throw error;
    }
    return queue;
  }

  private async appendJournalEntry(queue: QueueFile, entry: QueueJournalEntry) {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    if (!this.journalHasBase) {
      const base: QueueJournalEntry = { v: 1, op: "base", queue };
      await fs.appendFile(this.journalPath, `${JSON.stringify(base)}\n`, "utf8");
      this.journalHasBase = true;
      this.journalEntryCount += 1;
    }
    await fs.appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.journalEntryCount += 1;
  }

  private async compactJournal(queue: QueueFile) {
    const tempSnapshot = `${this.dbPath}.${process.pid}.tmp`;
    const tempJournal = `${this.journalPath}.${process.pid}.tmp`;
    const base: QueueJournalEntry = { v: 1, op: "base", queue };
    await fs.writeFile(tempSnapshot, JSON.stringify(queue), "utf8");
    await fs.copyFile(tempSnapshot, this.dbPath);
    await fs.writeFile(tempJournal, `${JSON.stringify(base)}\n`, "utf8");
    await fs.copyFile(tempJournal, this.journalPath);
    await Promise.all([
      fs.rm(tempSnapshot, { force: true }),
      fs.rm(tempJournal, { force: true }),
    ]);
    this.journalHasBase = true;
    this.journalEntryCount = 1;
  }

  private isMissingFileError(error: unknown) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        String((error as { code?: unknown }).code) === "ENOENT"
    );
  }
}
