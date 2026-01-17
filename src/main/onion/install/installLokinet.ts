import fs from "node:fs/promises";
import path from "node:path";
import type { OnionNetwork } from "../../net/netConfig";
import { downloadFile } from "./downloader";
import { verifySha256 } from "./verify";
import { unpackArchive } from "./unpack";
import { getPinnedSha256 } from "../componentRegistry";
import { swapWithRollback } from "./swapperRollback";
import { PinnedHashMissingError } from "../errors";

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

const LOKINET_RELEASE_BASE = "https://github.com/oxen-io/lokinet/releases/download";

const resolveDownload = (version: string, assetNameOverride?: string) => {
  const assetName = assetNameOverride ?? `lokinet-win32-${version}.zip`;
  return {
    assetName,
    url: `${LOKINET_RELEASE_BASE}/v${version}/${assetName}`,
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

  const tempDir = await fs.mkdtemp(path.join(userDataDir, "onion", "tmp-"));
  const resolvedUrl = downloadUrl ?? url;
  const archivePath = path.join(tempDir, assetName);
  onProgress?.({ step: "download", message: "Downloading Lokinet" });
  await downloadFile(resolvedUrl, archivePath, (progress) =>
    onProgress?.({ step: "download", ...progress })
  );
  onProgress?.({ step: "verify", message: "Verifying Lokinet" });
  await verifySha256(archivePath, hash);

  const installPath = path.join(userDataDir, "onion", "components", network, version);
  await fs.rm(installPath, { recursive: true, force: true });
  await fs.mkdir(installPath, { recursive: true });
  onProgress?.({ step: "unpack", message: "Unpacking Lokinet" });
  await unpackArchive(archivePath, installPath);
  onProgress?.({ step: "activate", message: "Activating Lokinet" });
  const rollback = await swapWithRollback(userDataDir, network, { version, path: installPath });
  return { version, installPath, rollback };
};
