import fs from "node:fs/promises";
import path from "node:path";
import { removeWithRetry } from "./removeWithRetry";

const isTorTempDirectory = async (onionRoot: string, entryName: string) => {
  if (entryName.startsWith("tmp-tor-")) return true;
  if (!entryName.startsWith("tmp-")) return false;
  try {
    const files = await fs.readdir(path.join(onionRoot, entryName));
    return files.some((name) => name.startsWith("tor-expert-bundle-"));
  } catch {
    return false;
  }
};

export const removeTorInstallationArtifacts = async (userDataDir: string) => {
  const onionRoot = path.join(userDataDir, "onion");
  const targets = [path.join(onionRoot, "components", "tor")];

  try {
    const entries = await fs.readdir(onionRoot, { withFileTypes: true });
    const tempTargets = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) =>
          (await isTorTempDirectory(onionRoot, entry.name))
            ? path.join(onionRoot, entry.name)
            : null
        )
    );
    targets.push(...tempTargets.filter((target): target is string => Boolean(target)));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await Promise.all(targets.map((target) => removeWithRetry(target)));
  return targets;
};
