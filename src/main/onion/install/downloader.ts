import fs from "node:fs";
import https from "node:https";
import { pipeline } from "node:stream/promises";

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number;
};

const getResponse = async (url: string, redirects = 0): Promise<https.IncomingMessage> => {
  if (redirects > 5) {
    throw new Error("Too many redirects");
  }
  const response = await new Promise<https.IncomingMessage>((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "nkc-onion-installer" } },
      (res) => resolve(res)
    );
    req.on("error", reject);
  });
  if (response.statusCode && [301, 302, 307, 308].includes(response.statusCode)) {
    const redirect = response.headers.location;
    response.resume();
    if (!redirect) {
      throw new Error("Redirect missing location header");
    }
    return getResponse(redirect, redirects + 1);
  }
  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`Download failed: ${response.statusCode}`);
  }
  return response;
};

export const downloadFile = async (
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void
) => {
  const request = await getResponse(url);

  const totalBytes = Number(request.headers["content-length"] ?? 0);
  let receivedBytes = 0;
  request.on("data", (chunk) => {
    receivedBytes += chunk.length;
    onProgress?.({ receivedBytes, totalBytes });
  });

  await pipeline(request, fs.createWriteStream(dest));
};
