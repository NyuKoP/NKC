const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

delete process.env.ELECTRON_RUN_AS_NODE;

const rootDir = path.resolve(__dirname, "..");
const distIndex = path.join(rootDir, "dist", "index.html");
const distMain = path.join(rootDir, "dist-electron", "main.js");
const distPreload = path.join(rootDir, "dist-electron", "preload.js");

const hasBuildOutput =
  fs.existsSync(distIndex) && fs.existsSync(distMain) && fs.existsSync(distPreload);

const getMtimeMsSafe = (targetPath) => {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return 0;
  }
};

const getLatestMtimeMs = (targetPath) => {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestMtimeMs(entryPath));
    } else {
      latest = Math.max(latest, getMtimeMsSafe(entryPath));
    }
  }
  return latest;
};

const sourcePaths = [
  path.join(rootDir, "src"),
  path.join(rootDir, "index.html"),
  path.join(rootDir, "package.json"),
  path.join(rootDir, "vite.config.ts"),
  path.join(rootDir, "tsconfig.json"),
  path.join(rootDir, "tsconfig.app.json"),
  path.join(rootDir, "tsconfig.node.json"),
];

const latestSourceMtime = Math.max(...sourcePaths.map((targetPath) => getLatestMtimeMs(targetPath)));
const oldestBuildMtime = Math.min(
  getMtimeMsSafe(distIndex),
  getMtimeMsSafe(distMain),
  getMtimeMsSafe(distPreload)
);
const buildOutdated = !hasBuildOutput || latestSourceMtime > oldestBuildMtime;
const shouldSkipBuild = process.env.NKC_SKIP_BUILD === "1";

if (!shouldSkipBuild && buildOutdated) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npmCmd, ["run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const electronBinary = require("electron");
const child = spawn(electronBinary, ["."], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
