const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const stripEnvVarCaseInsensitive = (env, key) => {
  const target = key.toLowerCase();
  for (const envKey of Object.keys(env)) {
    if (envKey.toLowerCase() === target) {
      delete env[envKey];
    }
  }
};

const childEnv = { ...process.env };
stripEnvVarCaseInsensitive(process.env, "ELECTRON_RUN_AS_NODE");
stripEnvVarCaseInsensitive(childEnv, "ELECTRON_RUN_AS_NODE");

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
  const build =
    process.platform === "win32"
      ? (() => {
          const npmExecPath = process.env.npm_execpath;
          if (npmExecPath && fs.existsSync(npmExecPath)) {
            return spawnSync(process.execPath, [npmExecPath, "run", "build"], {
              cwd: rootDir,
              stdio: "inherit",
              env: childEnv,
            });
          }
          const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
          return spawnSync(comspec, ["/d", "/s", "/c", "npm run build"], {
            cwd: rootDir,
            stdio: "inherit",
            env: childEnv,
            windowsHide: false,
          });
        })()
      : spawnSync("npm", ["run", "build"], {
          cwd: rootDir,
          stdio: "inherit",
          env: childEnv,
        });
  if (build.error) {
    console.error("[start] failed to run build:", build.error);
    process.exit(1);
  }
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const electronCli = require.resolve("electron/cli.js");
const child = spawn(process.execPath, [electronCli, "."], {
  cwd: rootDir,
  stdio: "inherit",
  env: childEnv,
  windowsHide: false,
});
const startedAt = Date.now();

child.on("error", (error) => {
  console.error("[start] failed to launch electron:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  const runtimeMs = Date.now() - startedAt;
  if ((code ?? 0) === 0 && runtimeMs < 2000) {
    console.warn(
      "[start] Electron exited quickly. If the app is already running, check the tray icon or stop existing Electron processes."
    );
  }
  process.exit(code ?? 0);
});
