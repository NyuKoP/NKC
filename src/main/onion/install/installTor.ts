import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { OnionNetwork } from "../../../net/netConfig";
import { downloadFile } from "./downloader";
import { verifySha256 } from "./verify";
import { unpackArchive } from "./unpack";
import { removeWithRetry } from "./removeWithRetry";
import { getBinaryPath } from "../componentRegistry";
import { readCurrentPointer, swapWithRollback } from "./swapperRollback";
import { getVerifiedTorManifest, resolveTorHash } from "../update/verifiedTorHashes";
import { getTorAssetName, getTorAssetUrl } from "../assetNaming";
import { assertTorVersion, TOR_ARCHIVE, TOR_PROOF, verifyInstalledTor } from "./installedTorProvenance";
import { compareVersions } from "../update/checkUpdates";

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

const ensureExecutable = async (binaryPath: string) => {
  if (process.platform === "win32") return;

  try {
    await fs.chmod(binaryPath, 0o755);
  } catch (error) {
    console.warn("[onion] failed to chmod tor binary", {
      binaryPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const clearMacQuarantine = async (targetPath: string) => {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve) => {
    execFile("xattr", ["-dr", "com.apple.quarantine", targetPath], () => resolve());
  });
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
  assertTorVersion(version);
  const network: OnionNetwork = "tor";
  const { assetName, url } = resolveDownload(version);
  const resolvedAssetName = assetNameOverride ?? assetName;

  const componentsRoot = path.resolve(userDataDir, "onion", "components", network);
  const current = await readCurrentPointer(userDataDir, network);

  if (current && compareVersions(version, current.version) < 0) throw new Error("TOR_DOWNGRADE_REFUSED");

  if (current?.version === version) {
    const currentPath = path.resolve(current.path);

    const isInsideSharedComponents =
      currentPath === componentsRoot || currentPath.startsWith(`${componentsRoot}${path.sep}`);

    const currentBinary = path.join(currentPath, getBinaryPath(network));

    if (isInsideSharedComponents && fsSync.existsSync(currentBinary)) {
      await verifyInstalledTor(userDataDir, current);

      return {
        version,
        installPath: currentPath,
        rollback: async () => undefined,
      };
    }
  }

  const hash = await resolveTorHash(version, resolvedAssetName);
  const baseOnionDir = path.join(userDataDir, "onion");
  await fs.mkdir(baseOnionDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(baseOnionDir, "tmp-tor-"));
  const resolvedUrl = downloadUrl ?? url;
  const archivePath = path.join(tempDir, resolvedAssetName);
  const installPath = path.join(userDataDir, "onion", "components", network, version);

  const details: {
    network: OnionNetwork;
    version: string;
    assetName: string;
    downloadUrl: string;
    archivePath: string;
    installPath: string;
    downloadBytes?: number;
    expectedSha256?: unknown;
    actualSha256?: unknown;
    binaryPath?: string;
  } = {
    network,
    version,
    assetName: resolvedAssetName,
    downloadUrl: resolvedUrl,
    archivePath,
    installPath,
  };

  try {
    onProgress?.({ step: "download", message: "Downloading Tor" });
    await downloadFile(resolvedUrl, archivePath, (progress) =>
      onProgress?.({ step: "download", ...progress })
    );
    const stat = await fs.stat(archivePath);
    details.downloadBytes = stat.size;

    onProgress?.({ step: "verify", message: "Verifying Tor" });
    await verifySha256(archivePath, hash);
    details.expectedSha256 = hash;

    const stagingPath = path.join(tempDir, "installation");
    await fs.mkdir(stagingPath);
    onProgress?.({ step: "unpack", message: "Unpacking Tor" });
    await unpackArchive(archivePath, stagingPath);
    const binaryPath = path.join(stagingPath, getBinaryPath(network));
    details.binaryPath = binaryPath;

    if (!fsSync.existsSync(binaryPath)) {
      throw new Error(`BINARY_MISSING: ${binaryPath}`);
    }

    await ensureExecutable(binaryPath);
    await clearMacQuarantine(stagingPath);
    const proof = await getVerifiedTorManifest(version);

    if (proof.hashes.get(resolvedAssetName) !== hash || resolvedAssetName !== getTorAssetName(version))
      throw new Error("TOR_ARCHIVE_IDENTITY_MISMATCH");

    await fs.copyFile(archivePath, path.join(stagingPath, TOR_ARCHIVE));
    await fs.writeFile(path.join(stagingPath, TOR_PROOF), JSON.stringify({
      manifest: proof.manifest, signature: proof.signature, key: proof.key,
    }));

    // Never remove the active version while replacing or repairing it.
    if (current?.version === version) throw new Error("TOR_ACTIVE_INSTALL_REPAIR_REQUIRED");

    await removeWithRetry(installPath);
    await fs.mkdir(path.dirname(installPath), { recursive: true });
    await fs.rename(stagingPath, installPath);
    await verifyInstalledTor(userDataDir, { version, path: installPath });

    onProgress?.({ step: "activate", message: "Activating Tor" });
    const rollback = await swapWithRollback(userDataDir, network, { version, path: installPath });

    return { version, installPath, rollback };
  } catch (error) {
    if (error && typeof error === "object") {
      if ("expected" in error && error.expected) details.expectedSha256 = error.expected;

      if ("actual" in error && error.actual) details.actualSha256 = error.actual;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[onion] Tor install failed", { message, details });
    throw Object.assign(new Error(`${message} | details=${JSON.stringify(details)}`), { details });
  } finally {
    await removeWithRetry(tempDir);
  }
};
