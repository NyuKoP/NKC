import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { socksFetch, type SocketFactory, type SocketLike } from "../socksHttpClient";

class FakeSocket extends EventEmitter implements SocketLike {
  writes: Buffer[] = [];
  destroyed = false;
  onWrite?: (data: Buffer, count: number) => void;

  write(data: Buffer) {
    this.writes.push(Buffer.from(data));
    if (this.onWrite) {
      this.onWrite(Buffer.from(data), this.writes.length);
    }
    return true;
  }

  end() {
    this.emit("end");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

const successHead = Buffer.from([0x05, 0x00, 0x00, 0x01]);
const successAddr = Buffer.from([0, 0, 0, 0]);
const successPort = Buffer.from([0, 0]);
const failHead = Buffer.from([0x05, 0x01, 0x00, 0x01]);

describe("socksFetch", () => {
  it("rejects when proxy connect fails", async () => {
    const socketFactory: SocketFactory = async () => {
      throw new Error("connect_fail");
    };
    await expect(
      socksFetch("http://example.com/", {
        method: "GET",
        socksProxyUrl: "socks5://127.0.0.1:9050",
        socketFactory,
      })
    ).rejects.toThrow("connect_fail");
  });

  it("rejects when SOCKS handshake fails", async () => {
    const socket = new FakeSocket();
    socket.onWrite = (_data, count) => {
      if (count === 1) setTimeout(() => socket.emit("data", Buffer.from([0x05, 0x00])), 0);
      if (count === 2) setTimeout(() => socket.emit("data", failHead), 0);
    };
    const socketFactory: SocketFactory = async () => socket;
    const promise = socksFetch("http://example.com/", {
      method: "GET",
      socksProxyUrl: "socks5://127.0.0.1:9050",
      socketFactory,
    });
    await expect(promise).rejects.toThrow("socks_connect_failed");
  });

  it("rejects invalid proxy scheme before connect", async () => {
    await expect(
      socksFetch("http://example.com/", {
        method: "GET",
        socksProxyUrl: "http://127.0.0.1:9050",
      })
    ).rejects.toThrow("unsupported_socks_protocol");
  });

  it("socks5h uses domain address type", async () => {
    const socket = new FakeSocket();
    socket.onWrite = (_data, count) => {
      if (count === 1) setTimeout(() => socket.emit("data", Buffer.from([0x05, 0x00])), 0);
      if (count === 2) {
        setTimeout(() => socket.emit("data", successHead), 0);
        setTimeout(() => socket.emit("data", successAddr), 1);
        setTimeout(() => socket.emit("data", successPort), 2);
      }
      if (count >= 3) {
        setTimeout(() => {
          socket.emit(
            "data",
            Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
          );
          socket.end();
        }, 10);
      }
    };
    const socketFactory: SocketFactory = async () => socket;
    const promise = socksFetch("http://example.onion/", {
      method: "GET",
      socksProxyUrl: "socks5h://127.0.0.1:9050",
      socketFactory,
    });
    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(socket.writes.length).toBeGreaterThanOrEqual(2);
    expect(socket.writes[1][3]).toBe(0x03);
  });
});
