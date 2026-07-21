import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export const DEFAULT_TOR_SOCKS_PROXY_URL = "socks5h://127.0.0.1:9050";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SOCKS_FIELD_BYTES = 255;

type SocketFactory = (options: { host: string; port: number }) => net.Socket;

type SocksProxyConfig = {
  host: string;
  port: number;
  remoteDns: boolean;
  username: string | null;
  password: string | null;
};

type BufferedSocketReader = {
  readExactly: (size: number) => Promise<Buffer>;
  dispose: () => void;
};

export type TorConnectOptions = {
  proxyUrl?: string;
  timeoutMs?: number;
  socketFactory?: SocketFactory;
};

export type TorAgentOptions = http.AgentOptions &
  TorConnectOptions & {
    secureEndpoint?: boolean;
  };

export type TorHttpRequestOptions = TorConnectOptions & {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
};

export type TorHttpResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const parseSocksProxyUrl = (value: string): SocksProxyConfig => {
  const url = new URL(value);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:" && url.protocol !== "socks:") {
    throw new Error("unsupported_socks_protocol");
  }

  const port = Number(url.port || "1080");
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid_socks_proxy");
  }

  const username = url.username ? decodeURIComponent(url.username) : null;
  const password = url.password ? decodeURIComponent(url.password) : null;
  if ((username && !password) || (!username && password)) {
    throw new Error("invalid_socks_auth");
  }
  if (
    username &&
    password &&
    (Buffer.byteLength(username, "utf8") > MAX_SOCKS_FIELD_BYTES ||
      Buffer.byteLength(password, "utf8") > MAX_SOCKS_FIELD_BYTES)
  ) {
    throw new Error("invalid_socks_auth");
  }

  return {
    host: url.hostname,
    port,
    remoteDns: url.protocol !== "socks5:",
    username,
    password,
  };
};

const createBufferedSocketReader = (socket: net.Socket): BufferedSocketReader => {
  let buffered = Buffer.alloc(0);
  let closedError: Error | null = null;
  let pending:
    | {
        size: number;
        resolve: (value: Buffer) => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;

  const tryResolvePending = () => {
    if (!pending) return;
    if (buffered.length >= pending.size) {
      const out = buffered.subarray(0, pending.size);
      buffered = buffered.subarray(pending.size);
      const { resolve } = pending;
      pending = null;
      resolve(Buffer.from(out));
      return;
    }
    if (closedError) {
      const { reject } = pending;
      pending = null;
      reject(closedError);
    }
  };

  const onData = (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    tryResolvePending();
  };

  const onError = (error: Error) => {
    closedError = error;
    tryResolvePending();
  };

  const onEnd = () => {
    closedError = new Error("socket_closed");
    tryResolvePending();
  };

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("end", onEnd);

  return {
    readExactly: (size: number) =>
      new Promise<Buffer>((resolve, reject) => {
        if (size <= 0) {
          resolve(Buffer.alloc(0));
          return;
        }
        if (pending) {
          reject(new Error("concurrent_read_not_supported"));
          return;
        }
        pending = { size, resolve, reject };
        tryResolvePending();
      }),
    dispose: () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      buffered = Buffer.alloc(0);
      if (pending) {
        pending.reject(new Error("reader_disposed"));
        pending = null;
      }
    },
  };
};

const readSocksBoundAddress = async (reader: BufferedSocketReader, addressType: number) => {
  if (addressType === 0x01) {
    await reader.readExactly(4);
  } else if (addressType === 0x03) {
    const length = await reader.readExactly(1);
    await reader.readExactly(length[0] ?? 0);
  } else if (addressType === 0x04) {
    await reader.readExactly(16);
  } else {
    throw new Error("socks_connect_failed");
  }
  await reader.readExactly(2);
};

const connectSocket = async (
  proxy: SocksProxyConfig,
  socketFactory?: SocketFactory
): Promise<net.Socket> => {
  const socket = socketFactory
    ? socketFactory({ host: proxy.host, port: proxy.port })
    : net.connect({ host: proxy.host, port: proxy.port });

  if (socket.connecting) {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  }

  return socket;
};

const writeSocksAddress = (host: string, remoteDns: boolean) => {
  const ipVersion = remoteDns ? 0 : net.isIP(host);
  if (ipVersion === 4) {
    return {
      addressType: 0x01,
      payload: Buffer.from(host.split(".").map((part) => Number(part))),
    };
  }
  const hostBytes = Buffer.from(host, "utf8");
  if (hostBytes.length > MAX_SOCKS_FIELD_BYTES) {
    throw new Error("target_host_too_long");
  }
  return {
    addressType: 0x03,
    payload: Buffer.concat([Buffer.from([hostBytes.length]), hostBytes]),
  };
};

export const isOnionHost = (host: string) => host.trim().toLowerCase().endsWith(".onion");

export const normalizeOnionHost = (value: string) =>
  value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

export const connectTorTcp = async (
  targetHost: string,
  targetPort: number,
  options: TorConnectOptions = {}
) => {
  const proxy = parseSocksProxyUrl(options.proxyUrl ?? DEFAULT_TOR_SOCKS_PROXY_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await connectSocket(proxy, options.socketFactory);
  const reader = createBufferedSocketReader(socket);
  const timeout = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);

  try {
    const authMethod = proxy.username && proxy.password ? 0x02 : 0x00;
    socket.write(Buffer.from([0x05, 0x01, authMethod]));
    const methodReply = await reader.readExactly(2);
    if (methodReply[0] !== 0x05 || methodReply[1] !== authMethod) {
      throw new Error("socks_auth_failed");
    }

    if (authMethod === 0x02) {
      const username = Buffer.from(proxy.username ?? "", "utf8");
      const password = Buffer.from(proxy.password ?? "", "utf8");
      socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
      const authReply = await reader.readExactly(2);
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
        throw new Error("socks_auth_failed");
      }
    }

    const address = writeSocksAddress(targetHost, proxy.remoteDns || isOnionHost(targetHost));
    const port = Buffer.alloc(2);
    port.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, address.addressType]), address.payload, port]));

    const replyHead = await reader.readExactly(4);
    if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
      throw new Error("socks_connect_failed");
    }
    await readSocksBoundAddress(reader, replyHead[3] ?? 0);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    reader.dispose();
    clearTimeout(timeout);
  }
};

export class TorSocksAgent extends http.Agent {
  private readonly proxyUrl: string;
  private readonly timeoutMs: number;
  private readonly secureEndpoint: boolean;
  private readonly socketFactory?: SocketFactory;

  constructor(options: TorAgentOptions = {}) {
    super(options);
    this.proxyUrl = options.proxyUrl ?? DEFAULT_TOR_SOCKS_PROXY_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.secureEndpoint = options.secureEndpoint ?? false;
    this.socketFactory = options.socketFactory;
  }

  addRequest(req: http.ClientRequest, options: http.RequestOptions) {
    const host = String(options.hostname ?? options.host ?? "");
    const port = Number(options.port ?? (this.secureEndpoint ? 443 : 80));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      req.destroy(new Error("invalid_target"));
      return;
    }

    void this.createTorSocket(host, port, options)
      .then((socket) => req.onSocket(socket))
      .catch((error) => req.destroy(error instanceof Error ? error : new Error(String(error))));
  }

  private async createTorSocket(
    host: string,
    port: number,
    requestOptions: http.RequestOptions
  ): Promise<net.Socket | tls.TLSSocket> {
    const socket = await connectTorTcp(host, port, {
      proxyUrl: this.proxyUrl,
      timeoutMs: this.timeoutMs,
      socketFactory: this.socketFactory,
    });

    if (!this.secureEndpoint) {
      return socket;
    }

    return tls.connect({
      socket,
      servername: getServername(requestOptions, host),
    });
  }
}

const getServername = (options: http.RequestOptions, fallbackHost: string) => {
  const maybeServername = (options as { servername?: unknown }).servername;
  return typeof maybeServername === "string" ? maybeServername : fallbackHost;
};

export const createTorProxyAgents = (options: TorConnectOptions = {}) => ({
  httpAgent: new TorSocksAgent({ ...options, secureEndpoint: false }),
  httpsAgent: new TorSocksAgent({ ...options, secureEndpoint: true }),
});

export const requestViaTor = async (
  url: string | URL,
  options: TorHttpRequestOptions = {}
): Promise<TorHttpResponse> => {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const isHttps = parsed.protocol === "https:";
  if (!isHttps && parsed.protocol !== "http:") {
    throw new Error("unsupported_protocol");
  }

  const body = typeof options.body === "string" ? Buffer.from(options.body, "utf8") : options.body;
  const { httpAgent, httpsAgent } = createTorProxyAgents(options);
  const requestOptions: http.RequestOptions = {
    method: options.method ?? "GET",
    headers: {
      Host: parsed.host,
      Connection: "close",
      ...options.headers,
      ...(body ? { "Content-Length": String(body.length) } : {}),
    },
    agent: isHttps ? httpsAgent : httpAgent,
  };

  return new Promise<TorHttpResponse>((resolve, reject) => {
    const req = (isHttps ? https : http).request(parsed, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.once("error", reject);
      res.once("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.once("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
};
