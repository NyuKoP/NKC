import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectTorTcp, createTorProxyAgents, requestViaTor } from "../torService";

type CapturedConnect = {
  host: string;
  port: number;
  addressType: number;
  payload: Buffer;
};

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

const createReader = (socket: net.Socket) => {
  let buffered = Buffer.alloc(0);
  let pending:
    | {
        size: number;
        resolve: (value: Buffer) => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;

  const tryResolvePending = () => {
    if (!pending || buffered.length < pending.size) return;
    const out = buffered.subarray(0, pending.size);
    buffered = buffered.subarray(pending.size);
    const { resolve } = pending;
    pending = null;
    resolve(Buffer.from(out));
  };

  const onData = (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    tryResolvePending();
  };

  const onError = (error: Error) => {
    if (!pending) return;
    const { reject } = pending;
    pending = null;
    reject(error);
  };

  const onEnd = () => {
    if (!pending) return;
    const { reject } = pending;
    pending = null;
    reject(new Error("socket_closed"));
  };

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("end", onEnd);

  return {
    readExactly: (size: number) =>
      new Promise<Buffer>((resolve, reject) => {
        pending = { size, resolve, reject };
        tryResolvePending();
      }),
    dispose: () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    },
  };
};

const listen = async (server: net.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return address.port;
};

const readSocksAddress = async (
  reader: ReturnType<typeof createReader>,
  addressType: number
) => {
  if (addressType === 0x03) {
    const length = await reader.readExactly(1);
    return reader.readExactly(length[0] ?? 0);
  }
  if (addressType === 0x01) {
    return reader.readExactly(4);
  }
  if (addressType === 0x04) {
    return reader.readExactly(16);
  }
  throw new Error("unsupported_address_type");
};

const startFakeSocksProxy = async (handler?: (socket: net.Socket) => void) => {
  let resolveCaptured: (value: CapturedConnect) => void = () => undefined;
  let rejectCaptured: (reason?: unknown) => void = () => undefined;
  const captured = new Promise<CapturedConnect>((resolve, reject) => {
    resolveCaptured = resolve;
    rejectCaptured = reject;
  });

  const server = net.createServer((socket) => {
    sockets.push(socket);
    const reader = createReader(socket);
    void (async () => {
      const greeting = await reader.readExactly(3);
      expect([...greeting]).toEqual([0x05, 0x01, 0x00]);
      socket.write(Buffer.from([0x05, 0x00]));

      const head = await reader.readExactly(4);
      const payload = await readSocksAddress(reader, head[3] ?? 0);
      const portBuffer = await reader.readExactly(2);
      const capturedConnect = {
        host: head[3] === 0x03 ? payload.toString("utf8") : payload.toString("hex"),
        port: portBuffer.readUInt16BE(0),
        addressType: head[3] ?? 0,
        payload,
      };
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      reader.dispose();
      resolveCaptured(capturedConnect);
      handler?.(socket);
    })().catch(rejectCaptured);
  });

  return { port: await listen(server), captured };
};

describe("torService", () => {
  it("connects to onion hosts through SOCKS5 using remote domain addressing", async () => {
    const proxy = await startFakeSocksProxy((socket) => socket.destroy());
    const socket = await connectTorTcp("peerabc.onion", 80, {
      proxyUrl: `socks5h://127.0.0.1:${proxy.port}`,
    });
    socket.destroy();

    await expect(proxy.captured).resolves.toMatchObject({
      host: "peerabc.onion",
      port: 80,
      addressType: 0x03,
    });
  });

  it("creates separate HTTP and HTTPS Tor agents", () => {
    const agents = createTorProxyAgents({ proxyUrl: "socks5h://127.0.0.1:9050" });
    expect(agents.httpAgent).toBeTruthy();
    expect(agents.httpsAgent).toBeTruthy();
  });

  it("sends HTTP requests through the SOCKS tunnel", async () => {
    const requestPromise = new Promise<string>((resolve) => {
      void (async () => {
        const proxy = await startFakeSocksProxy((socket) => {
          let raw = "";
          socket.on("data", (chunk) => {
            raw += chunk.toString("utf8");
            if (!raw.includes("\r\n\r\n")) return;
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            resolve(raw);
          });
        });
        const response = await requestViaTor(`http://peerabc.onion:80/inbox?x=1`, {
          proxyUrl: `socks5h://127.0.0.1:${proxy.port}`,
          timeoutMs: 1_000,
        });
        expect(response.statusCode).toBe(200);
        expect(response.body.toString("utf8")).toBe("ok");
      })();
    });

    await expect(requestPromise).resolves.toContain("GET /inbox?x=1 HTTP/1.1");
  });
});
