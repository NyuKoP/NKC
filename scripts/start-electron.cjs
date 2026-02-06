const { spawn } = require("node:child_process");

delete process.env.ELECTRON_RUN_AS_NODE;

const electronBinary = require("electron");
const child = spawn(electronBinary, ["."], {
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

