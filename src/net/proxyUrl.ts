const ALLOWED_PROXY_PROTOCOLS = new Set(["socks5:", "socks5h:", "http:", "https:"]);

export const isLocalhostHost = (hostname: string) =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

export const validateProxyUrl = (input: string) => {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Invalid proxy URL");
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error("Invalid proxy URL");
  }

  if (!url.hostname || !url.port) {
    throw new Error("Invalid proxy URL");
  }

  const port = Number(url.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy URL");
  }

  return { url, normalized: `${url.protocol}//${url.host}` };
};
