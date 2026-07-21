import type { OnionComponentState } from "./netConfig";
import { applyOnionUpdate, checkOnionUpdates, type OnionStatus } from "./onionControl";

export const TOR_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const compareVersions = (left: string, right: string) => {
  const leftParts = left.replace(/^v/i, "").split(".").map(Number);
  const rightParts = right.replace(/^v/i, "").split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

export const shouldAutoUpdateTor = (state: OnionComponentState) =>
  Boolean(
    state.installed &&
      state.version &&
      state.latest &&
      !state.error &&
      compareVersions(state.latest, state.version) > 0
  );

type AutoUpdateDependencies = {
  checkUpdates?: () => Promise<OnionStatus>;
  applyUpdate?: (network: "tor") => Promise<void>;
};

let inFlight: Promise<"updated" | "unchanged"> | null = null;

export const runVerifiedTorAutoUpdate = (
  dependencies: AutoUpdateDependencies = {}
): Promise<"updated" | "unchanged"> => {
  if (inFlight) return inFlight;
  const checkUpdates = dependencies.checkUpdates ?? checkOnionUpdates;
  const applyUpdate = dependencies.applyUpdate ?? applyOnionUpdate;
  inFlight = (async () => {
    const status = await checkUpdates();
    if (!shouldAutoUpdateTor(status.components.tor)) return "unchanged";
    await applyUpdate("tor");
    return "updated";
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
};
