import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager, type ManagedConnection } from "../connectionManager";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class FakeConnection implements ManagedConnection {
  sent: Uint8Array[] = [];
  closed = false;
  private dataHandlers = new Set<(bytes: Uint8Array) => void>();
  private closeHandlers = new Set<(error?: Error) => void>();

  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }

  close() {
    this.closed = true;
  }

  onData(handler: (bytes: Uint8Array) => void) {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emitData(frame: unknown) {
    const bytes =
      frame instanceof Uint8Array ? frame : textEncoder.encode(JSON.stringify(frame));
    this.dataHandlers.forEach((handler) => handler(bytes));
  }

  emitClose(error = new Error("closed")) {
    this.closeHandlers.forEach((handler) => handler(error));
  }

  parsedSent() {
    return this.sent.map((bytes) => JSON.parse(textDecoder.decode(bytes)) as { type: string; id: string });
  }
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with capped exponential backoff while outbox has pending messages", async () => {
    const connections: FakeConnection[] = [];
    const states: string[] = [];
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 2) throw new Error("dial_failed");
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    });
    const flushOutbox = vi.fn();
    const manager = new ConnectionManager({
      convId: "c1",
      connect,
      hasPendingOutbox: () => true,
      flushOutbox,
      onStateChange: (state, detail) => states.push(`${state}:${detail ?? ""}`),
    });

    await manager.start();
    expect(connect).toHaveBeenCalledTimes(1);
    connections[0].emitClose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(states).toContain("reconnecting:closed; retry_in=1000");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(manager.getState()).toBe("connected");
    expect(flushOutbox).toHaveBeenCalledTimes(2);
  });

  it("stops reconnecting when the outbox has no pending messages", async () => {
    const connection = new FakeConnection();
    const manager = new ConnectionManager({
      convId: "c1",
      connect: vi.fn(async () => connection),
      hasPendingOutbox: () => false,
    });

    await manager.start();
    connection.emitClose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.getState()).toBe("idle");
  });

  it("sends SYNC_PING after idle and reconnects on missing SYNC_PONG", async () => {
    let now = 0;
    const connections: FakeConnection[] = [];
    const manager = new ConnectionManager({
      convId: "c1",
      connect: vi.fn(async () => {
        const connection = new FakeConnection();
        connections.push(connection);
        return connection;
      }),
      hasPendingOutbox: () => true,
      heartbeatIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      now: () => now,
      createId: () => "ping-1",
    });

    await manager.start();
    now = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connections[0].parsedSent()).toEqual([
      { type: "SYNC_PING", id: "ping-1", ts: 30_000 },
    ]);

    now = 40_000;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(connections[0].closed).toBe(true);
    expect(manager.getState()).toBe("reconnecting");
  });

  it("answers SYNC_PING with SYNC_PONG and does not forward heartbeat frames", async () => {
    const connection = new FakeConnection();
    const onData = vi.fn();
    const manager = new ConnectionManager({
      convId: "c1",
      connect: vi.fn(async () => connection),
      hasPendingOutbox: () => true,
      onData,
      now: () => 123,
    });

    await manager.start();
    connection.emitData({ type: "SYNC_PING", id: "remote-ping", ts: 100 });

    expect(connection.parsedSent()).toEqual([
      { type: "SYNC_PONG", id: "remote-ping", ts: 123 },
    ]);
    expect(onData).not.toHaveBeenCalled();
  });

  it("clears reconnect and heartbeat timers on stop", async () => {
    let now = 0;
    const connections: FakeConnection[] = [];
    const connect = vi.fn(async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    });
    const manager = new ConnectionManager({
      convId: "c1",
      connect,
      hasPendingOutbox: () => true,
      heartbeatIntervalMs: 30_000,
      now: () => now,
    });

    await manager.start();
    connections[0].emitClose();
    await manager.stop();
    now = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe("closed");
  });

  it("coalesces concurrent start calls into one registered connection", async () => {
    let resolveConnection!: (connection: ManagedConnection) => void;
    const connection = new FakeConnection();
    const connect = vi.fn(
      () =>
        new Promise<ManagedConnection>((resolve) => {
          resolveConnection = resolve;
        })
    );
    const manager = new ConnectionManager({
      convId: "c1",
      connect,
      hasPendingOutbox: () => false,
    });

    const first = manager.start();
    const second = manager.start();
    resolveConnection(connection);
    await Promise.all([first, second]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe("connected");
    expect(connection.closed).toBe(false);
  });

  it("handles repeated close signals once and schedules one reconnect", async () => {
    const connection = new FakeConnection();
    const hasPendingOutbox = vi.fn(async () => true);
    const connect = vi.fn(async () => connection);
    const manager = new ConnectionManager({
      convId: "c1",
      connect,
      hasPendingOutbox,
    });

    await manager.start();
    connection.emitClose(new Error("socket_ended"));
    connection.emitClose(new Error("socket_closed"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(hasPendingOutbox).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("unregisters a connection when flushing the outbox fails", async () => {
    const connection = new FakeConnection();
    const manager = new ConnectionManager({
      convId: "c1",
      connect: vi.fn(async () => connection),
      hasPendingOutbox: () => false,
      flushOutbox: vi.fn(async () => {
        throw new Error("flush_failed");
      }),
    });

    await manager.start();

    expect(connection.closed).toBe(true);
    expect(manager.getState()).toBe("idle");
  });
});
