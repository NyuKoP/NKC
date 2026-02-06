const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

delete process.env.ELECTRON_RUN_AS_NODE;

const rootDir = path.resolve(__dirname, "..");
const distIndex = path.join(rootDir, "dist", "index.html");
const distMain = path.join(rootDir, "dist-electron", "main.js");
const hasBuildOutput = fs.existsSync(distIndex) && fs.existsSync(distMain);

if (!hasBuildOutput) {
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
