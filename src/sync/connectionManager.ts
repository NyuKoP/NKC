export type SyncPingFrame = {
  type: "SYNC_PING";
  id: string;
  ts: number;
};

export type SyncPongFrame = {
  type: "SYNC_PONG";
  id: string;
  ts: number;
};

export type ConnectionManagerFrame = SyncPingFrame | SyncPongFrame;

export type ManagedConnection = {
  send: (bytes: Uint8Array) => Promise<void> | void;
  close: () => Promise<void> | void;
  onData: (handler: (bytes: Uint8Array) => void) => () => void;
  onClose: (handler: (error?: Error) => void) => () => void;
};

export type ConnectionManagerState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export type ConnectionManagerOptions = {
  convId: string;
  connect: () => Promise<ManagedConnection>;
  hasPendingOutbox: (convId: string) => Promise<boolean> | boolean;
  flushOutbox?: (convId: string) => Promise<void> | void;
  onData?: (bytes: Uint8Array) => Promise<void> | void;
  onStateChange?: (state: ConnectionManagerState, detail?: string) => void;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  createId?: () => string;
};

type TorTcpSocketLike = {
  write: (data: Uint8Array) => boolean | void;
  destroy: () => void;
  on: (event: "data", handler: (chunk: Uint8Array) => void) => unknown;
  once: (event: "close" | "end" | "error", handler: (...args: unknown[]) => void) => unknown;
  off: (event: "data" | "close" | "end" | "error", handler: (...args: unknown[]) => void) => unknown;
};

export type TorTcpConnector = (
  host: string,
  port: number,
  options?: { proxyUrl?: string; timeoutMs?: number }
) => Promise<TorTcpSocketLike>;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBytes = (value: unknown) => textEncoder.encode(JSON.stringify(value));

const parseControlFrame = (bytes: Uint8Array): ConnectionManagerFrame | null => {
  try {
    const parsed = JSON.parse(textDecoder.decode(bytes)) as Partial<ConnectionManagerFrame>;
    if (parsed.type === "SYNC_PING" && typeof parsed.id === "string") {
      return { type: "SYNC_PING", id: parsed.id, ts: Number(parsed.ts) || Date.now() };
    }
    if (parsed.type === "SYNC_PONG" && typeof parsed.id === "string") {
      return { type: "SYNC_PONG", id: parsed.id, ts: Number(parsed.ts) || Date.now() };
    }
    return null;
  } catch {
    return null;
  }
};

const backoffDelayMs = (attempt: number, maxBackoffMs: number) =>
  Math.min(2 ** Math.max(0, attempt) * 1000, maxBackoffMs);

const defaultCreateId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sync-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

export class ConnectionManager {
  private readonly convId: string;
  private readonly connectFn: () => Promise<ManagedConnection>;
  private readonly hasPendingOutbox: ConnectionManagerOptions["hasPendingOutbox"];
  private readonly flushOutbox?: ConnectionManagerOptions["flushOutbox"];
  private readonly onData?: ConnectionManagerOptions["onData"];
  private readonly onStateChange?: ConnectionManagerOptions["onStateChange"];
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  private state: ConnectionManagerState = "idle";
  private connection: ManagedConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPingId: string | null = null;
  private reconnectAttempt = 0;
  private lastActivityAt = 0;
  private closed = false;
  private unsubs: Array<() => void> = [];

  constructor(options: ConnectionManagerOptions) {
    this.convId = options.convId;
    this.connectFn = options.connect;
    this.hasPendingOutbox = options.hasPendingOutbox;
    this.flushOutbox = options.flushOutbox;
    this.onData = options.onData;
    this.onStateChange = options.onStateChange;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? defaultCreateId;
  }

  getState() {
    return this.state;
  }

  async start() {
    this.closed = false;
    await this.openConnection("connecting");
  }

  async send(bytes: Uint8Array) {
    const connection = this.connection;
    if (!connection || this.state !== "connected") {
      await this.scheduleReconnectIfNeeded("send_without_connection");
      throw new Error("connection_not_ready");
    }
    try {
      await connection.send(bytes);
      this.markActivity();
    } catch (error) {
      await this.handleConnectionLost(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async stop() {
    this.closed = true;
    this.setState("closed");
    this.clearReconnectTimer();
    this.stopHeartbeat();
    await this.detachConnection();
  }

  private async openConnection(state: ConnectionManagerState) {
    if (this.closed) return;
    this.setState(state);
    try {
      const connection = await this.connectFn();
      if (this.closed) {
        await connection.close();
        return;
      }
      await this.attachConnection(connection);
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.startHeartbeat();
      await this.flushOutbox?.(this.convId);
    } catch (error) {
      await this.scheduleReconnectIfNeeded(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async attachConnection(connection: ManagedConnection) {
    await this.detachConnection();
    this.connection = connection;
    this.markActivity();
    this.unsubs = [
      connection.onData((bytes) => {
        void this.handleIncoming(bytes);
      }),
      connection.onClose((error) => {
        void this.handleConnectionLost(error ?? new Error("connection_closed"));
      }),
    ];
  }

  private async detachConnection() {
    const connection = this.connection;
    this.connection = null;
    this.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
    if (connection) {
      try {
        await connection.close();
      } catch {
        // close errors do not change recovery state
      }
    }
  }

  private async handleIncoming(bytes: Uint8Array) {
    this.markActivity();
    const control = parseControlFrame(bytes);
    if (control?.type === "SYNC_PING") {
      await this.connection?.send(toBytes({ type: "SYNC_PONG", id: control.id, ts: this.now() }));
      this.markActivity();
      return;
    }
    if (control?.type === "SYNC_PONG") {
      if (control.id === this.pendingPingId) {
        this.pendingPingId = null;
        this.clearPongTimer();
      }
      return;
    }
    await this.onData?.(bytes);
  }

  private async handleConnectionLost(error: Error) {
    if (this.closed) return;
    this.stopHeartbeat();
    await this.detachConnection();
    await this.scheduleReconnectIfNeeded(error.message);
  }

  private async scheduleReconnectIfNeeded(reason: string) {
    if (this.closed || this.reconnectTimer) return;
    const pending = await this.hasPendingOutbox(this.convId);
    if (!pending) {
      this.setState("idle", reason);
      return;
    }
    const delay = backoffDelayMs(this.reconnectAttempt, this.maxBackoffMs);
    this.reconnectAttempt += 1;
    this.setState("reconnecting", `${reason}; retry_in=${delay}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection("connecting");
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.maybeSendPing();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
    this.pendingPingId = null;
  }

  private async maybeSendPing() {
    if (!this.connection || this.state !== "connected" || this.pendingPingId) return;
    if (this.now() - this.lastActivityAt < this.heartbeatIntervalMs) return;
    const pingId = this.createId();
    this.pendingPingId = pingId;
    try {
      await this.connection.send(toBytes({ type: "SYNC_PING", id: pingId, ts: this.now() }));
      this.pongTimer = setTimeout(() => {
        void this.handleConnectionLost(new Error("heartbeat_timeout"));
      }, this.pongTimeoutMs);
    } catch (error) {
      await this.handleConnectionLost(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private markActivity() {
    this.lastActivityAt = this.now();
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPongTimer() {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private setState(state: ConnectionManagerState, detail?: string) {
    this.state = state;
    this.onStateChange?.(state, detail);
  }
}

export const createDataChannelConnection = (channel: RTCDataChannel): ManagedConnection => ({
  send: (bytes) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    channel.send(copy);
  },
  close: () => channel.close(),
  onData: (handler) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        handler(new Uint8Array(data));
        return;
      }
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => handler(new Uint8Array(buffer)));
        return;
      }
      if (typeof data === "string") {
        handler(textEncoder.encode(data));
      }
    };
    channel.addEventListener("message", onMessage);
    return () => channel.removeEventListener("message", onMessage);
  },
  onClose: (handler) => {
    const onClose = () => handler();
    const onError = () => handler(new Error("datachannel_error"));
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    return () => {
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
    };
  },
});

export const createTorTcpConnectionFactory =
  (
    connectTorTcp: TorTcpConnector,
    options: { onionHost: string; onionPort?: number; proxyUrl?: string; timeoutMs?: number }
  ) =>
  async (): Promise<ManagedConnection> => {
    const socket = await connectTorTcp(options.onionHost, options.onionPort ?? 80, {
      proxyUrl: options.proxyUrl,
      timeoutMs: options.timeoutMs,
    });
    return {
      send: (bytes) =>
        new Promise<void>((resolve, reject) => {
          try {
            const ok = socket.write(bytes);
            if (ok === false) {
              setTimeout(resolve, 0);
              return;
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        }),
      close: () => socket.destroy(),
      onData: (handler) => {
        const onData = (chunk: Uint8Array) => handler(chunk);
        socket.on("data", onData);
        return () => socket.off("data", onData as (...args: unknown[]) => void);
      },
      onClose: (handler) => {
        const onClose = () => handler();
        const onEnd = () => handler(new Error("socket_ended"));
        const onError = (error: unknown) =>
          handler(error instanceof Error ? error : new Error(String(error)));
        socket.once("close", onClose);
        socket.once("end", onEnd);
        socket.once("error", onError);
        return () => {
          socket.off("close", onClose);
          socket.off("end", onEnd);
          socket.off("error", onError);
        };
      },
    };
  };
