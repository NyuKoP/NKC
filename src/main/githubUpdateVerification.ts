import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { UpdateInfo } from "electron-updater";

// Unsigned distribution trusts this GitHub repository, not an Authenticode publisher.
export const verifyGithubUpdate = async (files: string[], info: UpdateInfo) => {
  if (!/^\d+\.\d+\.\d+$/.test(info.version) || files.length !== 1) throw new Error("UPDATE_ASSET_INVALID");
  const tag = `v${info.version}`;
  const response = await fetch(`https://api.github.com/repos/NyuKoP/NKC/releases/tags/${tag}`, {
    signal: AbortSignal.timeout(30_000), redirect: "error",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "NKC-updater", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok || !response.body) throw new Error("UPDATE_RELEASE_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("UPDATE_RELEASE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error("UPDATE_RELEASE_INVALID");
  }
  const names = info.files.map(file => {
    const url = new URL(file.url, `https://github.com/NyuKoP/NKC/releases/download/${tag}/`);
    const prefix = `/NyuKoP/NKC/releases/download/${tag}/`;
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix) || url.search || url.hash) {
      throw new Error("UPDATE_ASSET_INVALID");
    }
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!name || /[/\\]/.test(name)) throw new Error("UPDATE_ASSET_INVALID");
    return name;
  });
  const extension = process.platform === "win32" ? ".exe" : ".AppImage";
  const candidates = release.assets.filter((asset: { name?: unknown; state?: unknown }) =>
    typeof asset.name === "string" && names.includes(asset.name) && asset.name.endsWith(extension) && asset.state === "uploaded");
  if (candidates.length !== 1) throw new Error("UPDATE_ASSET_INVALID");
  const asset = candidates[0];
  if (asset.browser_download_url !== `https://github.com/NyuKoP/NKC/releases/download/${tag}/${encodeURIComponent(asset.name)}` ||
      typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error("UPDATE_DIGEST_MISSING");
  if ((await stat(files[0])).size !== asset.size) throw new Error("UPDATE_SIZE_MISMATCH");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(files[0])) hash.update(chunk);
  if (`sha256:${hash.digest("hex")}` !== asset.digest) throw new Error("UPDATE_DIGEST_MISMATCH");
};
