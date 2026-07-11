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

const emptyQueue = (): QueueFile => ({ friends: [], messages: [] });

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

const readJsonFrame = (socket: SocketLike, timeoutMs: number) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("ack_timeout"));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered, "utf8") > MAX_FRAME_BYTES) {
        cleanup();
        reject(new Error("frame_too_large"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      const raw = buffered.slice(0, newline).trim();
      cleanup();
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        reject(new Error("invalid_frame"));
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

export class P2POfflineQueueManager {
  private readonly dbPath: string;
  private readonly getTorSocksProxy: () => string | null;
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

  constructor(options: P2POfflineQueueManagerOptions) {
    this.dbPath = options.dbPath;
    this.getTorSocksProxy = options.getTorSocksProxy;
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

  async setFriends(friends: P2PFriendRoute[]) {
    await this.withQueue(async (queue) => {
      const byFriendId = new Map(queue.friends.map((friend) => [friend.friendId, friend]));
      for (const friend of friends) {
        const onionAddress = normalizeOnionAddress(friend.onionAddress);
        if (!friend.friendId || !onionAddress.endsWith(".onion")) continue;
        byFriendId.set(friend.friendId, { friendId: friend.friendId, onionAddress });
      }
      queue.friends = [...byFriendId.values()];
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
      if (!queue.friends.some((friend) => friend.friendId === input.friendId)) {
        queue.friends.push({ friendId: input.friendId, onionAddress });
      }
      const existing = queue.messages.find((item) => item.id === message.id);
      if (existing) {
        if (existing.status !== "DELIVERED") {
          existing.status = "PENDING";
          existing.updatedAt = now;
          existing.lastError = undefined;
        }
        return;
      }
      queue.messages.push(message);
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
      const socksProxy = this.getTorSocksProxy();
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
    try {
      socket = await this.connect(
        socksProxy,
        friend.onionAddress,
        ONION_VIRTUAL_PORT,
        this.connectTimeoutMs
      );
      writeFrame(socket, {
        type: "NKC_P2P_HELLO",
        version: 1,
        friendId: friend.friendId,
        ts: this.now(),
      });
      const helloAck = await readJsonFrame(socket, this.ackTimeoutMs);
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
      const ack = await readJsonFrame(socket, this.ackTimeoutMs);
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
      socket?.destroy();
      this.inFlight.delete(friend.friendId);
    }
  }

  private async markInFlight(ids: string[]) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      queue.messages.forEach((message) => {
        if (!ids.includes(message.id) || message.status !== "PENDING") return;
        message.status = "IN_FLIGHT";
        message.updatedAt = now;
        message.lastError = undefined;
      });
    });
  }

  private async markDelivered(ids: string[]) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      queue.messages.forEach((message) => {
        if (!ids.includes(message.id)) return;
        message.status = "DELIVERED";
        message.updatedAt = now;
        message.deliveredAt = now;
        message.lastError = undefined;
      });
    });
  }

  private async resetInFlightForFriend(friendId: string, error: string) {
    const now = this.now();
    await this.withQueue(async (queue) => {
      queue.messages.forEach((message) => {
        if (message.friendId !== friendId || message.status !== "IN_FLIGHT") return;
        message.status = "PENDING";
        message.updatedAt = now;
        message.lastError = error;
      });
    });
  }

  private async withQueue(mutator: (queue: QueueFile) => Promise<void> | void) {
    const nextWrite = this.writeLock.catch(() => undefined).then(async () => {
      const queue = await this.readQueue();
      await mutator(queue);
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      await fs.writeFile(this.dbPath, JSON.stringify(queue, null, 2), "utf8");
    });
    this.writeLock = nextWrite;
    await nextWrite;
  }

  private async readQueue(): Promise<QueueFile> {
    try {
      const raw = await fs.readFile(this.dbPath, "utf8");
      const parsed = JSON.parse(raw) as QueueFile;
      if (!Array.isArray(parsed.friends) || !Array.isArray(parsed.messages)) {
        return emptyQueue();
      }
      return parsed;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        String((error as { code?: unknown }).code) === "ENOENT"
      ) {
        return emptyQueue();
      }
      throw error;
    }
  }
}
