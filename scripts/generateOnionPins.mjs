import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const fetchText = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "nkc-onion-pinner" } });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${url}`);
  }
  return res.text();
};

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "nkc-onion-pinner" } });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${url}`);
  }
  return res.json();
};

const sha256FromUrl = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "nkc-onion-pinner" } });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} ${url}`);
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of res.body) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const compareVersions = (a, b) => {
  const aParts = a.replace(/^v/i, "").split(".").map(Number);
  const bParts = b.replace(/^v/i, "").split(".").map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }
  return 0;
};

const torPlatformMap = new Map([
  ["windows", "win32"],
  ["linux", "linux"],
  ["macos", "darwin"],
  ["android", "android"],
]);

const torArchMap = new Map([
  ["x86_64", "x64"],
  ["i686", "ia32"],
  ["aarch64", "arm64"],
  ["armv7", "arm"],
  ["x86", "ia32"],
]);

const extractTorPins = async () => {
  const torIndex = await fetchText("https://dist.torproject.org/torbrowser/");
  const versions = Array.from(torIndex.matchAll(/href="(\d+\.\d+\.\d+)\//g)).map(
    (match) => match[1]
  );
  const latest = versions.sort(compareVersions).at(-1);
  if (!latest) {
    throw new Error("No Tor versions found");
  }
  const shaText = await fetchText(
    `https://dist.torproject.org/torbrowser/${latest}/sha256sums-signed-build.txt`
  );
  const pins = [];
  for (const line of shaText.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (!match) continue;
    const [, hash, filename] = match;
    if (!filename.startsWith("tor-expert-bundle-") || !filename.endsWith(".tar.gz")) {
      continue;
    }
    const parts = filename
      .replace("tor-expert-bundle-", "")
      .replace(".tar.gz", "")
      .split("-");
    if (parts.length < 3) continue;
    const [platformRaw, archRaw, version] = parts;
    const platform = torPlatformMap.get(platformRaw);
    const arch = torArchMap.get(archRaw);
    if (!platform || !arch) continue;
    pins.push({
      platform,
      arch,
      version,
      filename,
      sha256: hash,
    });
  }
  return pins;
};

const detectPlatform = (name) => {
  if (/win32|windows/i.test(name)) return "win32";
  if (/macos|darwin|osx|mac/i.test(name)) return "darwin";
  if (/linux/i.test(name)) return "linux";
  if (/android/i.test(name)) return "android";
  return null;
};

const detectArch = (name) => {
  if (/x86_64|amd64/i.test(name)) return "x64";
  if (/i686|x86(?!_64)/i.test(name)) return "ia32";
  if (/arm64|aarch64/i.test(name)) return "arm64";
  if (/armv7|arm(?!64)/i.test(name)) return "arm";
  return null;
};

const extractLokinetPins = async () => {
  const release = await fetchJson("https://api.github.com/repos/oxen-io/lokinet/releases/latest");
  const version = String(release.tag_name ?? "").replace(/^v/i, "");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const pins = [];
  for (const asset of assets) {
    if (!asset?.name || !asset?.browser_download_url) continue;
    if (asset.name.endsWith(".asc") || asset.name.endsWith(".sig")) continue;
    const platform = detectPlatform(asset.name);
    const arch = detectArch(asset.name);
    if (!platform || !arch) continue;
    const sha256 = await sha256FromUrl(asset.browser_download_url);
    pins.push({
      platform,
      arch,
      version,
      filename: asset.name,
      sha256,
    });
  }
  return pins;
};

const renderMap = (entries) => {
  return entries
    .map(
      (entry) =>
        `    [makePinnedKey({ platform: "${entry.platform}", arch: "${entry.arch}", version: "${entry.version}", filename: "${entry.filename}" })]: "${entry.sha256}",`
    )
    .join("\n");
};

const main = async () => {
  const torPins = await extractTorPins();
  const lokinetPins = await extractLokinetPins();
  const output = `export type PinnedKeyParts = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  version: string;
  filename: string;
};

export const makePinnedKey = (parts: PinnedKeyParts) =>
  \`\${parts.platform}:\${parts.arch}:\${parts.version}:\${parts.filename}\`;

export const pinnedSha256 = {
  tor: {
${renderMap(torPins)}
  },
  lokinet: {
${renderMap(lokinetPins)}
  },
} as const;
`;

  const outputPath = path.join(process.cwd(), "src", "main", "onion", "pinnedHashes.ts");
  await fs.writeFile(outputPath, output, "utf8");
  console.log(`Wrote ${outputPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
