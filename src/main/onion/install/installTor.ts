import fs from "node:fs/promises";
import path from "node:path";
import type { OnionNetwork } from "../../net/netConfig";
import { downloadFile } from "./downloader";
import { verifySha256 } from "./verify";
import { unpackArchive } from "./unpack";
import { getPinnedSha256 } from "../componentRegistry";
import { swapWithRollback } from "./swapperRollback";
import { PinnedHashMissingError } from "../errors";
import { getTorAssetName, getTorAssetUrl } from "../assetNaming";

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

const resolveDownload = (version: string) => {
  const assetName = getTorAssetName(version);
  return {
    assetName,
    url: getTorAssetUrl(version),
  };
};

export const installTor = async (
  userDataDir: string,
  version: string,
  onProgress?: (progress: InstallProgress) => void,
  downloadUrl?: string,
  assetNameOverride?: string
): Promise<InstallResult> => {
  const network: OnionNetwork = "tor";
  const { assetName, url } = resolveDownload(version);
  const resolvedAssetName = assetNameOverride ?? assetName;
  const hash = getPinnedSha256(network, { version, assetName: resolvedAssetName });
  if (!hash) {
    throw new PinnedHashMissingError(
      `Missing pinned hash for Tor asset ${resolvedAssetName} (${version}).`
    );
  }

  const tempDir = await fs.mkdtemp(path.join(userDataDir, "onion", "tmp-"));
  const resolvedUrl = downloadUrl ?? url;
  const archivePath = path.join(tempDir, resolvedAssetName);
  onProgress?.({ step: "download", message: "Downloading Tor" });
  await downloadFile(resolvedUrl, archivePath, (progress) =>
    onProgress?.({ step: "download", ...progress })
  );
  onProgress?.({ step: "verify", message: "Verifying Tor" });
  await verifySha256(archivePath, hash);

  const installPath = path.join(userDataDir, "onion", "components", network, version);
  await fs.rm(installPath, { recursive: true, force: true });
  await fs.mkdir(installPath, { recursive: true });
  onProgress?.({ step: "unpack", message: "Unpacking Tor" });
  await unpackArchive(archivePath, installPath);
  onProgress?.({ step: "activate", message: "Activating Tor" });
  const rollback = await swapWithRollback(userDataDir, network, { version, path: installPath });
  return { version, installPath, rollback };
};
