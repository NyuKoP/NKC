import fs from "node:fs/promises";
import path from "node:path";

const fetchText = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "nkc-onion-pinner" } });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${url}`);
  }
  return res.text();
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
