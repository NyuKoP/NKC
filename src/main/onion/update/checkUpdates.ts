import type { OnionNetwork } from "../../../net/netConfig";
import { getTorAssetName, getTorAssetUrl } from "../assetNaming";
import { fetchTorMetadata, resolveTorHash } from "./verifiedTorHashes";

type UpdateCheckResult = {
  version: string | null;
  assetName: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  errorCode?: "PINNED_HASH_MISSING" | "ASSET_NOT_FOUND";
  errorReason?: string;
};

export const compareVersions = (a: string, b: string) => {
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

const checkTorUpdates = async (): Promise<UpdateCheckResult> => {
  const indexHtml = await fetchTorMetadata("https://dist.torproject.org/torbrowser/");

  const versions = Array.from(indexHtml.matchAll(/href="(\d+\.\d+\.\d+)\//g)).map(
    (match) => match[1]
  );

  const latest = versions.sort(compareVersions).at(-1);

  if (!latest) return { version: null, assetName: null, downloadUrl: null, sha256: null };
  const assetName = getTorAssetName(latest);
  let sha256: string | null = null;
  let errorReason: string | undefined;

  try {
    sha256 = await resolveTorHash(latest, assetName);
  } catch (error) {
    errorReason = error && typeof error === "object" && "details" in error
      ? String(error.details)
      : error instanceof Error ? error.message : String(error);
  }

  return {
    version: latest,
    assetName,
    downloadUrl: getTorAssetUrl(latest),
    sha256: sha256 ?? null,
    errorCode: sha256 ? undefined : "PINNED_HASH_MISSING",
    errorReason,
  };
};

export const checkUpdates = async (network: OnionNetwork) => {
  if (network !== "tor") throw new Error("Unsupported onion network");

  return checkTorUpdates();
};
