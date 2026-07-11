import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { P2POfflineQueueManager } from "../p2pOfflineQueueManager";

class FakeSocket extends EventEmitter {
  writes: string[] = [];

  constructor(private readonly coalescedAckIds: string[] | null = null) {
    super();
  }

  write(data: string | Buffer) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    this.writes.push(text);
    const frame = JSON.parse(text.trim()) as { type?: string; messages?: Array<{ id: string }> };
    if (frame.type === "NKC_P2P_HELLO") {
      queueMicrotask(() => {
        const helloAck = JSON.stringify({ type: "NKC_P2P_HELLO_ACK" }) + "\n";
        const pushAck = this.coalescedAckIds
          ? JSON.stringify({ type: "NKC_P2P_ACK", messageIds: this.coalescedAckIds }) + "\n"
          : "";
        this.emit("data", Buffer.from(helloAck + pushAck));
      });
    }
    if (frame.type === "NKC_P2P_PUSH" && !this.coalescedAckIds) {
      const messageIds = frame.messages?.map((message) => message.id) ?? [];
      queueMicrotask(() => {
        this.emit("data", Buffer.from(JSON.stringify({ type: "NKC_P2P_ACK", messageIds }) + "\n"));
      });
    }
    return true;
  }

  destroy() {
    this.emit("close");
    return this;
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const makeDbPath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-p2p-queue-"));
  tempDirs.push(dir);
  return path.join(dir, "queue.json");
};

describe("P2POfflineQueueManager", () => {
  it("stores offline messages as PENDING", async () => {
    const manager = new P2POfflineQueueManager({
      dbPath: await makeDbPath(),
      getTorSocksProxy: () => "socks5h://127.0.0.1:9050",
      uuid: () => "msg-1",
    });

    await manager.enqueueMessage({
      friendId: "friend-1",
      onionAddress: "peerabc.onion",
      payload: "ciphertext",
      createdAt: 10,
    });

    expect(await manager.listMessages()).toMatchObject([
      {
        id: "msg-1",
        friendId: "friend-1",
        onionAddress: "peerabc.onion",
        payload: "ciphertext",
        status: "PENDING",
        createdAt: 10,
      },
    ]);
  });

  it("pushes pending messages in creation order and marks ACKed messages DELIVERED", async () => {
    const socket = new FakeSocket();
    const manager = new P2POfflineQueueManager({
      dbPath: await makeDbPath(),
      getTorSocksProxy: () => "socks5h://127.0.0.1:9050",
      connect: async () => socket as unknown as net.Socket,
      uuid: () => "unused",
      now: () => 100,
    });

    await manager.enqueueMessage({
      id: "second",
      friendId: "friend-1",
      onionAddress: "peerabc.onion",
      payload: "payload-2",
      createdAt: 20,
    });
    await manager.enqueueMessage({
      id: "first",
      friendId: "friend-1",
      onionAddress: "peerabc.onion",
      payload: "payload-1",
      createdAt: 10,
    });

    await manager.flushNow();

    const push = JSON.parse(socket.writes[1].trim()) as {
      messages: Array<{ id: string; payload: string }>;
    };
    expect(push.messages.map((message) => message.id)).toEqual(["first", "second"]);
    expect((await manager.listMessages()).map((message) => message.status)).toEqual([
      "DELIVERED",
      "DELIVERED",
    ]);
  });

  it("keeps the leftover bytes when multiple frames arrive in one data event", async () => {
    const socket = new FakeSocket(["first"]);
    const manager = new P2POfflineQueueManager({
      dbPath: await makeDbPath(),
      getTorSocksProxy: () => "socks5h://127.0.0.1:9050",
      connect: async () => socket as unknown as net.Socket,
      uuid: () => "unused",
      now: () => 100,
    });

    await manager.enqueueMessage({
      id: "first",
      friendId: "friend-1",
      onionAddress: "peerabc.onion",
      payload: "payload-1",
      createdAt: 10,
    });

    await manager.flushNow();

    expect((await manager.listMessages())[0].status).toBe("DELIVERED");
  });
});
