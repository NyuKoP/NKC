import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { OnionNetwork } from "../../../net/netConfig";
import { downloadFile } from "./downloader";
import { verifySha256 } from "./verify";
import { unpackArchive } from "./unpack";
import { getBinaryPath, getPinnedSha256 } from "../componentRegistry";
import { swapWithRollback } from "./swapperRollback";
import { PinnedHashMissingError } from "../errors";
import { getLokinetAssetName, getLokinetAssetUrlForName } from "../assetNaming";

type InstallProgress = {
  step: "download" | "verify" | "unpack" | "activate";
  message?: string;
  receivedBytes?: number;
  totalBytes?: number;
};

type InstallResult = {
  version: string;
  installPath: string;
  rollback: () => Promise<void>;
};

const resolveDownload = (version: string, assetNameOverride?: string) => {
  const assetName = assetNameOverride ?? getLokinetAssetName(version);
  return {
    assetName,
    url: getLokinetAssetUrlForName(version, assetName),
  };
};

export const installLokinet = async (
  userDataDir: string,
  version: string,
  onProgress?: (progress: InstallProgress) => void,
  downloadUrl?: string,
  assetNameOverride?: string
): Promise<InstallResult> => {
  const network: OnionNetwork = "lokinet";
  const { assetName, url } = resolveDownload(version, assetNameOverride);
  const hash = getPinnedSha256(network, { version, assetName });
  if (!hash) {
    throw new PinnedHashMissingError(
      `Missing pinned hash for Lokinet asset ${assetName} (${version}).`
    );
  }

  const baseOnionDir = path.join(userDataDir, "onion");
  await fs.mkdir(baseOnionDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(baseOnionDir, "tmp-"));
  const resolvedUrl = downloadUrl ?? url;
  const archivePath = path.join(tempDir, assetName);
  const installPath = path.join(userDataDir, "onion", "components", network, version);
  const details: Record<string, unknown> = {
    network,
    version,
    assetName,
    downloadUrl: resolvedUrl,
    archivePath,
    installPath,
  };
  onProgress?.({ step: "download", message: "Downloading Lokinet" });
  try {
    await downloadFile(resolvedUrl, archivePath, (progress) =>
      onProgress?.({ step: "download", ...progress })
    );
    const stat = await fs.stat(archivePath);
    details.downloadBytes = stat.size;

    onProgress?.({ step: "verify", message: "Verifying Lokinet" });
    await verifySha256(archivePath, hash);
    details.expectedSha256 = hash;

    await fs.rm(installPath, { recursive: true, force: true });
    await fs.mkdir(installPath, { recursive: true });
    onProgress?.({ step: "unpack", message: "Unpacking Lokinet" });
    await unpackArchive(archivePath, installPath);
    const binaryPath = path.join(installPath, getBinaryPath(network));
    details.binaryPath = binaryPath;
    if (!fsSync.existsSync(binaryPath)) {
      throw new Error(`BINARY_MISSING: ${binaryPath}`);
    }
    onProgress?.({ step: "activate", message: "Activating Lokinet" });
    const rollback = await swapWithRollback(userDataDir, network, { version, path: installPath });
    return { version, installPath, rollback };
  } catch (error) {
    if (error && typeof error === "object") {
      const err = error as { expected?: string; actual?: string };
      if (err.expected) details.expectedSha256 = err.expected;
      if (err.actual) details.actualSha256 = err.actual;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[onion] Lokinet install failed", { message, details });
    const wrapped = new Error(`${message} | details=${JSON.stringify(details)}`);
    (wrapped as { details?: Record<string, unknown> }).details = details;
    throw wrapped;
  }
};
