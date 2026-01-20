import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
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

const runInstaller = async (filePath: string) => {
  if (process.platform !== "win32") {
    throw new Error("Installer execution is only supported on Windows");
  }
  const escapedPath = filePath.replace(/'/g, "''");
  const psCommand = `Start-Process -FilePath '${escapedPath}' -ArgumentList '/S' -Verb RunAs -Wait`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCommand],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            `${error.message}\n${stderr || stdout || ""}`.trim()
          );
          (wrapped as { details?: Record<string, unknown> }).details = {
            filePath,
            stderr: stderr?.toString?.() ?? String(stderr ?? ""),
            stdout: stdout?.toString?.() ?? String(stdout ?? ""),
            code: (error as unknown as { code?: string }).code,
          };
          reject(wrapped);
          return;
        }
        void stdout;
        void stderr;
        resolve();
      }
    );
  });
};

const findLokinetBinaryWin32 = async () => {
  const candidates: string[] = [];
  await new Promise<void>((resolve) => {
    execFile("where.exe", ["lokinet.exe"], { windowsHide: true }, (_error, stdout) => {
      if (stdout) {
        candidates.push(
          ...stdout
            .toString()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
      }
      resolve();
    });
  });

  candidates.push(
    "C:\\\\Program Files\\\\Lokinet\\\\lokinet.exe",
    "C:\\\\Program Files (x86)\\\\Lokinet\\\\lokinet.exe",
    "C:\\\\Program Files\\\\Lokinet\\\\lokinet\\\\lokinet.exe",
    "C:\\\\Program Files (x86)\\\\Lokinet\\\\lokinet\\\\lokinet.exe"
  );

  const ps = async (command: string) => {
    return new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
        (_error, stdout) => resolve((stdout ?? "").toString())
      );
    });
  };

  // Registry install location (most reliable).
  const installLocationsRaw = await ps(
    "$paths=@(); " +
      "$roots=@('HKLM:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\*','HKLM:\\\\Software\\\\WOW6432Node\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\*'); " +
      "foreach($r in $roots){ " +
      "  Get-ItemProperty $r -ErrorAction SilentlyContinue | " +
      "    Where-Object { $_.DisplayName -match 'Lokinet' -or $_.DisplayName -match 'lokinet' } | " +
      "    ForEach-Object { if($_.InstallLocation){$paths+=$_.InstallLocation} } " +
      "}; " +
      "$paths | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { $_ }"
  );
  for (const line of installLocationsRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    candidates.push(path.join(line, "lokinet.exe"));
    candidates.push(path.join(line, "lokinet", "lokinet.exe"));
  }

  // Service image path (fallback).
  const servicePathRaw = await ps(
    "(Get-ItemProperty 'HKLM:\\\\SYSTEM\\\\CurrentControlSet\\\\Services\\\\lokinet' -ErrorAction SilentlyContinue).ImagePath"
  );
  const servicePath = servicePathRaw.trim().replace(/^"|"$/g, "");
  if (servicePath) {
    // ImagePath may include args; take the exe portion.
    const exePath = servicePath.split(/\s+/)[0].replace(/^"|"$/g, "");
    candidates.push(exePath);
    candidates.push(path.join(path.dirname(exePath), "lokinet.exe"));
  }

  for (const file of candidates) {
    if (fsSync.existsSync(file)) {
      return { binaryPath: file, baseDir: path.dirname(file) };
    }
  }
  return null;
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

    if (process.platform === "win32" && assetName.toLowerCase().endsWith(".exe")) {
      onProgress?.({ step: "activate", message: "Installing Lokinet (requires admin)" });
      await runInstaller(archivePath);
      const found = await findLokinetBinaryWin32();
      if (!found) {
        throw new Error("BINARY_MISSING: lokinet.exe not found after installer");
      }
      details.binaryPath = found.binaryPath;
      const rollback = await swapWithRollback(userDataDir, network, {
        version,
        path: found.baseDir,
      });
      return { version, installPath: found.baseDir, rollback };
    }

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
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};
