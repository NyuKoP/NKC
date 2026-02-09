import net from "node:net";
import tls from "node:tls";

type SocksFetchOptions = {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  socksProxyUrl: string;
  retry?: {
    attempts?: number;
    delayMs?: number;
  };
  socketFactory?: SocketFactory;
};

type SocksFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_INFLIGHT = 8;

type SocksErrorCode = "timeout" | "proxy_unreachable" | "handshake_failed" | "upstream_error";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let inflight = 0;
const inflightQueue: Array<() => void> = [];

const acquireSlot = () =>
  new Promise<void>((resolve) => {
    if (inflight < MAX_INFLIGHT) {
      inflight += 1;
      resolve();
      return;
    }
    inflightQueue.push(() => {
      inflight += 1;
      resolve();
    });
  });

const releaseSlot = () => {
  inflight = Math.max(0, inflight - 1);
  const next = inflightQueue.shift();
  if (next) {
    next();
  }
};

const parseSocksUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("unsupported_socks_protocol");
  }
  const host = url.hostname;
  const port = Number(url.port || "0");
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error("invalid_socks_proxy");
  }
  const username = url.username ? decodeURIComponent(url.username) : null;
  const password = url.password ? decodeURIComponent(url.password) : null;
  const hasAuth = username !== null || password !== null;
  if (hasAuth) {
    if (!username || !password) throw new Error("invalid_socks_auth");
    const usernameLen = Buffer.byteLength(username, "utf8");
    const passwordLen = Buffer.byteLength(password, "utf8");
    if (usernameLen > 255 || passwordLen > 255) throw new Error("invalid_socks_auth");
  }
  return { host, port, protocol: url.protocol, username, password };
};

export type SocketLike = {
  on: (event: "data", listener: (chunk: Buffer) => void) => void;
  once: (event: "end" | "error", listener: (...args: unknown[]) => void) => void;
  off: (
    event: "data" | "end" | "error",
    listener: ((chunk: Buffer) => void) | ((...args: unknown[]) => void)
  ) => void;
  write: (data: Buffer) => boolean;
  end: () => void;
  destroy: () => void;
};

export type SocketFactory = (opts: { host: string; port: number }) => Promise<SocketLike>;

type BufferedSocketReader = {
  readExactly: (size: number) => Promise<Buffer>;
  dispose: () => void;
};

const createBufferedSocketReader = (socket: SocketLike): BufferedSocketReader => {
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
    const incoming = Buffer.from(chunk);
    buffered = buffered.length === 0 ? incoming : Buffer.concat([buffered, incoming]);
    tryResolvePending();
  };

  const onEnd = () => {
    closedError = new Error("eof");
    tryResolvePending();
  };

  const onError = (error: unknown) => {
    closedError = error instanceof Error ? error : new Error(String(error));
    tryResolvePending();
  };

  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("error", onError);

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
      socket.off("end", onEnd);
      socket.off("error", onError);
      buffered = Buffer.alloc(0);
      if (pending) {
        pending.reject(new Error("reader_disposed"));
        pending = null;
      }
    },
  };
};

const connectSocks = async (
  targetHost: string,
  targetPort: number,
  proxyUrl: string,
  socketFactory?: SocketFactory,
  onSocket?: (socket: SocketLike) => void,
  timeoutState?: { timedOut: boolean }
) => {
  const proxy = parseSocksUrl(proxyUrl);
  const socket = socketFactory
    ? await socketFactory({ host: proxy.host, port: proxy.port })
    : net.connect(proxy.port, proxy.host);
  if (onSocket) onSocket(socket);
  if (!socketFactory) {
    await new Promise<void>((resolve, reject) => {
      (socket as net.Socket).once("connect", resolve);
      (socket as net.Socket).once("error", reject);
    });
  }
  if (timeoutState?.timedOut) {
    socket.destroy();
    throw new Error("timeout");
  }
  const reader = createBufferedSocketReader(socket);
  try {
    const authRequested = Boolean(proxy.username && proxy.password);
    const requestedMethod = authRequested ? 0x02 : 0x00;
    socket.write(Buffer.from([0x05, 0x01, requestedMethod]));
    const methodReply = await reader.readExactly(2);
    if (methodReply[0] !== 0x05 || methodReply[1] !== requestedMethod) {
      throw new Error("socks_auth_failed");
    }

    if (authRequested) {
      const usernameBytes = Buffer.from(proxy.username!, "utf8");
      const passwordBytes = Buffer.from(proxy.password!, "utf8");
      const authReq = Buffer.concat([
        Buffer.from([0x01, usernameBytes.length]),
        usernameBytes,
        Buffer.from([passwordBytes.length]),
        passwordBytes,
      ]);
      socket.write(authReq);
      const authReply = await reader.readExactly(2);
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
        throw new Error("socks_auth_failed");
      }
    }

    const ipVersion = proxy.protocol === "socks5h:" ? 0 : net.isIP(targetHost);
    let addrType = 0x03;
    let addrPayload: Buffer;
    if (ipVersion === 4) {
      addrType = 0x01;
      addrPayload = Buffer.from(targetHost.split(".").map((part) => Number(part)));
    } else {
      const hostBuf = Buffer.from(targetHost, "utf8");
      if (hostBuf.length > 255) throw new Error("socks_connect_failed");
      addrPayload = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
    }

    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, addrType]), addrPayload, portBuf]);
    socket.write(req);

    const replyHead = await reader.readExactly(4);
    if (replyHead[1] !== 0x00) {
      throw new Error("socks_connect_failed");
    }
    const replyAddrType = replyHead[3];
    if (replyAddrType === 0x01) {
      await reader.readExactly(4);
    } else if (replyAddrType === 0x03) {
      const len = await reader.readExactly(1);
      await reader.readExactly(len[0]);
    } else if (replyAddrType === 0x04) {
      await reader.readExactly(16);
    }
    await reader.readExactly(2);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    reader.dispose();
  }

  if (timeoutState?.timedOut) {
    socket.destroy();
    throw new Error("timeout");
  }

  return socket;
};

const parseHeaders = (raw: string) => {
  const lines = raw.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const statusMatch = statusLine.match(/HTTP\/\d+\.\d+\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string> = {};
  lines.forEach((line) => {
    const idx = line.indexOf(":");
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  });
  return { status, headers };
};

const decodeChunkedBody = (buffer: Buffer) => {
  let offset = 0;
  const chunks: Buffer[] = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeHex = buffer.slice(offset, lineEnd).toString("utf8").trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    const end = start + size;
    chunks.push(buffer.slice(start, end));
    offset = end + 2;
  }
  return Buffer.concat(chunks);
};

const readHttpResponse = async (socket: SocketLike, timeoutMs: number) => {
  const chunks: Buffer[] = [];
  let total = 0;
  let timeoutError: Error | null = null;
  const done = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        socket.destroy();
        reject(new Error("response_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve();
    const onError = (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      reject(err);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
  const timeout = setTimeout(() => {
    socket.destroy();
    timeoutError = new Error("timeout");
  }, timeoutMs);
  try {
    await done;
    if (timeoutError) {
      throw timeoutError;
    }
  } finally {
    clearTimeout(timeout);
  }
  const buffer = Buffer.concat(chunks);
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return { status: 0, headers: {}, body: Buffer.alloc(0) };
  }
  const headerRaw = buffer.slice(0, headerEnd).toString("utf8");
  const { status, headers } = parseHeaders(headerRaw);
  let body = buffer.slice(headerEnd + 4);
  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    body = decodeChunkedBody(body);
  } else if (headers["content-length"]) {
    const length = Number.parseInt(headers["content-length"], 10);
    if (Number.isFinite(length)) {
      body = body.slice(0, length);
    }
  }
  return { status, headers, body };
};

const socksFetchOnce = async (url: string, opts: SocksFetchOptions): Promise<SocksFetchResponse> => {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  if (!isHttps && parsed.protocol !== "http:") {
    throw new Error("unsupported_protocol");
  }
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  const host = parsed.hostname;
  const path = `${parsed.pathname}${parsed.search}`;
  const timeoutMs = opts.timeoutMs ?? 10000;

  let socket: SocketLike | null = null;
  const timeoutState = { timedOut: false };
  const timeout = setTimeout(() => {
    timeoutState.timedOut = true;
    if (socket) {
      socket.destroy();
    }
  }, timeoutMs);
  try {
    socket = await connectSocks(
      host,
      port,
      opts.socksProxyUrl,
      opts.socketFactory,
      (created) => {
        socket = created;
        if (timeoutState.timedOut) {
          created.destroy();
        }
      },
      timeoutState
    );
    if (timeoutState.timedOut) {
      socket.destroy();
      throw new Error("timeout");
    }
  } finally {
    clearTimeout(timeout);
  }
  const transport = isHttps
    ? tls.connect({ socket: socket as net.Socket, servername: host })
    : socket;

  const headers: Record<string, string> = {
    Host: host,
    Connection: "close",
    ...opts.headers,
  };
  const body = opts.body ?? Buffer.alloc(0);
  if (body.length) {
    headers["Content-Length"] = String(body.length);
  }

  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  const request = Buffer.from(
    `${opts.method} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`
  );
  transport.write(request);
  if (body.length) {
    transport.write(body);
  }
  transport.end();
  await sleep(0);
  return readHttpResponse(transport, timeoutMs);
};

const normalizeSocksError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error);
  const knownCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const rawCode = knownCode.toLowerCase();
  const text = message.toLowerCase();

  let code: SocksErrorCode = "upstream_error";
  if (rawCode === "timeout" || text.includes("timeout")) {
    code = "timeout";
  } else if (
    rawCode.includes("econnrefused") ||
    rawCode.includes("enotfound") ||
    rawCode.includes("ehostunreach") ||
    rawCode.includes("econnreset") ||
    text.includes("connect_fail")
  ) {
    code = "proxy_unreachable";
  } else if (
    text.includes("socks_auth_failed") ||
    text.includes("socks_connect_failed") ||
    text.includes("unsupported_socks_protocol") ||
    text.includes("invalid_socks_proxy") ||
    text.includes("invalid_socks_auth")
  ) {
    code = "handshake_failed";
  }

  const err = new Error(message);
  (err as { code?: SocksErrorCode }).code = code;
  return err;
};

export async function socksFetch(url: string, opts: SocksFetchOptions): Promise<SocksFetchResponse> {
  await acquireSlot();
  const attempts = Math.min(2, Math.max(1, opts.retry?.attempts ?? 1));
  const delayMs = Math.max(50, opts.retry?.delayMs ?? 200);
  let lastError: Error | null = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await socksFetchOnce(url, opts);
      } catch (error) {
        lastError = normalizeSocksError(error);
        if (attempt < attempts - 1) {
          await sleep(delayMs * (attempt + 1));
        }
      }
    }
    throw lastError ?? normalizeSocksError(new Error("socks_fetch_failed"));
  } finally {
    releaseSlot();
  }
}
