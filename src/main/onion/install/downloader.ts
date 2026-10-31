import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { URL } from "node:url";

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number;
};

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const getResponse = async (url: string, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> => {
  if (redirects > 5) {
    throw new Error("Too many redirects");
  }

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = https.get(
      url,
      { signal, headers: { "User-Agent": "nkc-onion-installer" } },
      (res) => resolve(res)
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Tor download stalled")));
  });

  if (response.statusCode && [301, 302, 307, 308].includes(response.statusCode)) {
    const redirect = response.headers.location;
    response.resume();

    if (!redirect) {
      throw new Error("Redirect missing location header");
    }

    const nextUrl = new URL(redirect, url).toString();

    return getResponse(nextUrl, signal, redirects + 1);
  }

  if (response.statusCode !== 200) {
    const status = response.statusCode;
    const statusMessage = response.statusMessage ?? "";
    response.resume();
    throw Object.assign(new Error(`Download failed: ${status} ${statusMessage}`.trim()), { details: {
      url,
      status,
      statusMessage,
    } });
  }

  return response;
};

export const downloadFile = async (
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void
) => {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const request = await getResponse(url, signal);

  const totalBytes = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_DOWNLOAD_BYTES) {
    request.destroy();
    throw new Error("Invalid Tor download size");
  }
  let receivedBytes = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        callback(new Error("Tor download exceeds size limit"));
        return;
      }
      try {
        onProgress?.({ receivedBytes, totalBytes });
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  await pipeline(request, progress, fs.createWriteStream(dest), { signal });
};
