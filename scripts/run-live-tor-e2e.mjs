import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const large = args.has("--large");
const sizeArg = [...args].find((value) => value.startsWith("--size-mb="));
const sizeMb = sizeArg?.slice("--size-mb=".length) ?? "10";

const findBundledTor = () => {
  if (process.env.NKC_TOR_PATH && fs.existsSync(process.env.NKC_TOR_PATH)) {
    return process.env.NKC_TOR_PATH;
  }
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const componentRoot = path.join(appData, "test", "onion", "components", "tor");
  if (!fs.existsSync(componentRoot)) return null;
  const versions = fs
    .readdirSync(componentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const binary = path.join(componentRoot, version, "tor", process.platform === "win32" ? "tor.exe" : "tor");
    if (fs.existsSync(binary)) return binary;
  }
  return null;
};

const torPath = findBundledTor();
if (!torPath) {
  console.error("Tor binary not found. Install Tor in NKC or set NKC_TOR_PATH.");
  process.exit(1);
}

const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestEntry, "run", "src/main/__tests__/torLiveE2E.test.ts", "--reporter=verbose"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NKC_TOR_PATH: torPath,
      NKC_LIVE_TOR_E2E: "1",
      NKC_LIVE_TOR_LARGE_E2E: large ? "1" : "0",
      NKC_LIVE_TOR_ONLY_LARGE: large ? "1" : "0",
      NKC_LIVE_TOR_FILE_MB: sizeMb,
    },
  }
);

if (result.error) {
  console.error(`Failed to start live Tor test: ${result.error.message}`);
}
process.exit(result.status ?? 1);
