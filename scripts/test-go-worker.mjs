import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const candidates = [
  process.env.GO_BINARY,
  process.platform === "win32" ? "C:\\Program Files\\Go\\bin\\go.exe" : "go",
  "go",
].filter(Boolean);
const goBinary = candidates.find((candidate) =>
  path.isAbsolute(candidate) ? fs.existsSync(candidate) : true
);
if (!goBinary) {
  console.error("Go compiler not found. Install Go or set GO_BINARY.");
  process.exit(1);
}
const result = spawnSync(goBinary, ["test", "./..."], {
  cwd: path.join(root, "native", "nkc-worker"),
  stdio: "inherit",
  env: { ...process.env, GOCACHE: path.join(root, "node_modules", ".cache", "go-build") },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
