import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import {
  clearSocksAgentPool,
  socksFetch,
  type SocketFactory,
  type SocketLike,
} from "../socksHttpClient";

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
    // Local write shutdown does not imply that the remote response has ended.
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
  it("reuses one SOCKS tunnel for sequential HTTP requests", async () => {
    let targetConnections = 0;
    let socksHandshakes = 0;
    const target = http.createServer((_req, res) => {
      res.end("OK");
    });
    target.on("connection", () => {
      targetConnections += 1;
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("target-listen-failed");

    const proxy = net.createServer((client) => {
      let buffered = Buffer.alloc(0);
      let stage = 0;
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (stage === 0 && buffered.length >= 3) {
          buffered = buffered.subarray(3);
          stage = 1;
          client.write(Buffer.from([0x05, 0x00]));
        }
        if (stage !== 1 || buffered.length < 5) return;
        const addressLength = buffered[3] === 0x03 ? buffered[4] : buffered[3] === 0x01 ? 4 : 16;
        const requestLength = 4 + (buffered[3] === 0x03 ? 1 : 0) + addressLength + 2;
        if (buffered.length < requestLength) return;
        buffered = buffered.subarray(requestLength);
        stage = 2;
        socksHandshakes += 1;
        client.off("data", onData);
        const upstream = net.connect(targetAddress.port, "127.0.0.1", () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buffered.length) upstream.write(buffered);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once("error", () => client.destroy());
      };
      client.on("data", onData);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy-listen-failed");
    const proxyUrl = `socks5h://127.0.0.1:${proxyAddress.port}`;

    try {
      const first = await socksFetch("http://keepalive-test.onion/one", {
        method: "GET",
        socksProxyUrl: proxyUrl,
      });
      const second = await socksFetch("http://keepalive-test.onion/two", {
        method: "GET",
        socksProxyUrl: proxyUrl,
      });
      expect(first).toMatchObject({ status: 200, body: Buffer.from("OK") });
      expect(second).toMatchObject({ status: 200, body: Buffer.from("OK") });
      expect(socksHandshakes).toBe(1);
      expect(targetConnections).toBe(1);
    } finally {
      clearSocksAgentPool(proxyUrl);
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  });

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

  it("rejects when a stalled SOCKS handshake is closed by the timeout", async () => {
    const socket = new FakeSocket();
    const socketFactory: SocketFactory = async () => socket;
    const error = await socksFetch("http://example.onion/", {
      method: "GET",
      socksProxyUrl: "socks5h://127.0.0.1:9050",
      socketFactory,
      timeoutMs: 30,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("timeout");
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
          socket.emit("end");
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

  it("supports socks5 username/password authentication", async () => {
    const socket = new FakeSocket();
    socket.onWrite = (data, count) => {
      if (count === 1) {
        expect(Array.from(data)).toEqual([0x05, 0x01, 0x02]);
        setTimeout(() => socket.emit("data", Buffer.from([0x05, 0x02])), 0);
      }
      if (count === 2) {
        expect(data[0]).toBe(0x01);
        const usernameLen = data[1];
        const username = data.subarray(2, 2 + usernameLen).toString("utf8");
        const passwordLen = data[2 + usernameLen];
        const password = data
          .subarray(3 + usernameLen, 3 + usernameLen + passwordLen)
          .toString("utf8");
        expect(username).toBe("alice");
        expect(password).toBe("secret");
        setTimeout(() => socket.emit("data", Buffer.from([0x01, 0x00])), 0);
      }
      if (count === 3) {
        setTimeout(() => socket.emit("data", successHead), 0);
        setTimeout(() => socket.emit("data", successAddr), 1);
        setTimeout(() => socket.emit("data", successPort), 2);
      }
      if (count >= 4) {
        setTimeout(() => {
          socket.emit(
            "data",
            Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
          );
          socket.emit("end");
        }, 10);
      }
    };
    const socketFactory: SocketFactory = async () => socket;
    await expect(
      socksFetch("http://example.com/", {
        method: "GET",
        socksProxyUrl: "socks5://alice:secret@127.0.0.1:9050",
        socketFactory,
      })
    ).resolves.toMatchObject({ status: 200 });
  });

  it("handles coalesced SOCKS replies without dropping buffered bytes", async () => {
    const socket = new FakeSocket();
    socket.onWrite = (_data, count) => {
      if (count === 1) {
        const combined = Buffer.concat([
          Buffer.from([0x05, 0x00]),
          successHead,
          successAddr,
          successPort,
        ]);
        setTimeout(() => socket.emit("data", combined), 0);
      }
      if (count >= 3) {
        setTimeout(() => {
          socket.emit(
            "data",
            Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
          );
          socket.emit("end");
        }, 10);
      }
    };
    const socketFactory: SocketFactory = async () => socket;
    await expect(
      socksFetch("http://example.com/", {
        method: "GET",
        socksProxyUrl: "socks5://127.0.0.1:9050",
        socketFactory,
        timeoutMs: 300,
      })
    ).resolves.toMatchObject({ status: 200 });
  });

  it("captures an HTTP response emitted synchronously while writing the request", async () => {
    const socket = new FakeSocket();
    socket.onWrite = (_data, count) => {
      if (count === 1) setTimeout(() => socket.emit("data", Buffer.from([0x05, 0x00])), 0);
      if (count === 2) {
        setTimeout(() => socket.emit("data", successHead), 0);
        setTimeout(() => socket.emit("data", successAddr), 1);
        setTimeout(() => socket.emit("data", successPort), 2);
      }
      if (count === 3) {
        socket.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"));
        socket.emit("end");
      }
    };

    const socketFactory: SocketFactory = async () => socket;
    await expect(
      socksFetch("http://example.onion/health", {
        method: "GET",
        socksProxyUrl: "socks5h://127.0.0.1:9050",
        socketFactory,
        timeoutMs: 300,
      })
    ).resolves.toMatchObject({ status: 200, body: Buffer.from("OK") });
  });
});
