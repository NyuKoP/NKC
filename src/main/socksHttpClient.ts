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
};

type SocksFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

const MAX_BODY_BYTES = 256 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseSocksUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("unsupported_socks_protocol");
  }
  if (url.username || url.password) {
    throw new Error("socks_auth_unsupported");
  }
  const host = url.hostname;
  const port = Number(url.port || "0");
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error("invalid_socks_proxy");
  }
  return { host, port };
};

const readExactly = (socket: net.Socket, size: number) =>
  new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= size) {
        socket.off("data", onData);
        resolve(buffer.slice(0, size));
      }
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });

const connectSocks = async (targetHost: string, targetPort: number, proxyUrl: string) => {
  const proxy = parseSocksUrl(proxyUrl);
  const socket = net.connect(proxy.port, proxy.host);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const methodReply = await readExactly(socket, 2);
  if (methodReply[0] !== 0x05 || methodReply[1] !== 0x00) {
    socket.destroy();
    throw new Error("socks_auth_failed");
  }

  const ipVersion = net.isIP(targetHost);
  let addrType = 0x03;
  let addrPayload: Buffer;
  if (ipVersion === 4) {
    addrType = 0x01;
    addrPayload = Buffer.from(targetHost.split(".").map((part) => Number(part)));
  } else {
    const hostBuf = Buffer.from(targetHost, "utf8");
    addrPayload = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf]);
  }

  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort, 0);
  const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, addrType]), addrPayload, portBuf]);
  socket.write(req);

  const replyHead = await readExactly(socket, 4);
  if (replyHead[1] !== 0x00) {
    socket.destroy();
    throw new Error("socks_connect_failed");
  }
  const replyAddrType = replyHead[3];
  if (replyAddrType === 0x01) {
    await readExactly(socket, 4);
  } else if (replyAddrType === 0x03) {
    const len = await readExactly(socket, 1);
    await readExactly(socket, len[0]);
  } else if (replyAddrType === 0x04) {
    await readExactly(socket, 16);
  }
  await readExactly(socket, 2);

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

const readHttpResponse = async (socket: net.Socket, timeoutMs: number) => {
  const chunks: Buffer[] = [];
  let total = 0;
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
    const onError = (error: Error) => reject(error);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
  const timeout = setTimeout(() => {
    socket.destroy();
  }, timeoutMs);
  try {
    await done;
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

  const socket = await connectSocks(host, port, opts.socksProxyUrl);
  const transport = isHttps
    ? tls.connect({ socket, servername: host })
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

export async function socksFetch(url: string, opts: SocksFetchOptions): Promise<SocksFetchResponse> {
  const attempts = Math.max(1, opts.retry?.attempts ?? 1);
  const delayMs = Math.max(50, opts.retry?.delayMs ?? 200);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await socksFetchOnce(url, opts);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts - 1) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }
  throw lastError ?? new Error("socks_fetch_failed");
}
