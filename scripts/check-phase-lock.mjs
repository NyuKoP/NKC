import { execSync } from "node:child_process";
import fs from "node:fs";

const lockedCoreFiles = new Set([
  "src/main/socksHttpClient.ts",
  "src/main/onionController.ts",
  "src/net/onionInboxClient.ts",
  "src/adapters/transports/onionRouterTransport.ts",
  "src/main/torManager.ts",
  "src/main/lokinetManager.ts",
  "src/main/routePolicy.ts",
  "src/security/preferences.ts",
  "src/devices/devicePairing.ts",
]);

const runGit = (args) => {
  try {
    return execSync(`git ${args}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const isGitRepo = () => runGit("rev-parse --is-inside-work-tree") === "true";

if (!isGitRepo()) {
  console.log("[phase-lock] Not a git repo; nothing to check.");
  process.exit(0);
}

const stagedRaw = runGit("diff --name-only --cached");
if (!stagedRaw) {
  console.log("[phase-lock] No staged changes; nothing to check.");
  process.exit(0);
}

const stagedFiles = stagedRaw.split(/\r?\n/).filter(Boolean);
const hasUiChanges = stagedFiles.some((file) => file.endsWith(".tsx"));
const changedLocked = stagedFiles.filter((file) => lockedCoreFiles.has(file));
const hasLockedChanges = changedLocked.length > 0;

if (hasUiChanges && hasLockedChanges) {
  console.error("[phase-lock] UI and locked core files cannot be staged together.");
  console.error("[phase-lock] Locked files:", changedLocked.join(", "));
  process.exit(1);
}

if (hasLockedChanges) {
  const phaseLockedPath = "docs/PHASES-LOCKED.md";
  if (!stagedFiles.includes(phaseLockedPath)) {
    console.error("[phase-lock] Locked core changes require updating docs/PHASES-LOCKED.md.");
    process.exit(1);
  }
  const content = fs.readFileSync(phaseLockedPath, "utf8");
  const sectionIndex = content.indexOf("## Unlocked By");
  if (sectionIndex === -1) {
    console.error("[phase-lock] Missing 'Unlocked By' section in docs/PHASES-LOCKED.md.");
    process.exit(1);
  }
  const section = content.slice(sectionIndex);
  if (section.includes("TBD")) {
    console.error("[phase-lock] Update 'Unlocked By' section with real values.");
    process.exit(1);
  }
}

console.log("[phase-lock] OK");
