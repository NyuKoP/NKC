import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getTorAssetName } from "../assetNaming";
import { getBinaryPath } from "../componentRegistry";
import { compareVersions } from "../update/checkUpdates";
import { verifyTorManifest } from "../update/verifiedTorHashes";
import { verifySha256 } from "./verify";
import { unpackArchive } from "./unpack";

export const TOR_MINIMUM_BUNDLE = "15.0.25"; // Contains the 0.4.9.14 security fixes.

export const TOR_ARCHIVE = "verified-bundle.tar.gz";

export const TOR_PROOF = "verified-manifest.json";

export const assertTorVersion = (version: string) => {
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, TOR_MINIMUM_BUNDLE) < 0)
    throw new Error("TOR_SECURITY_UPDATE_REQUIRED");
};

// Rebuild the file inventory from authenticated archive bytes, never a local hash receipt.
const inventory = async (directory: string, relative = ""): Promise<Map<string, string>> => {
  const result = new Map<string, string>();

  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);

    if (!relative && [TOR_ARCHIVE, TOR_PROOF].includes(name)) continue;

    if (entry.isDirectory()) {
      for (const [child, hash] of await inventory(directory, name)) result.set(child, hash);
    } else if (entry.isFile()) {
      result.set(name, createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex"));
    } else throw new Error("TOR_INSTALL_LINK_REFUSED");
  }

  return result;
};

export const verifyInstalledTor = async (userDataDir: string, pointer: { version: string; path: string }) => {
  assertTorVersion(pointer.version);
  const expected = path.resolve(userDataDir, "onion/components/tor", pointer.version);

  if (path.resolve(pointer.path) !== expected || await fs.realpath(expected) !== expected)
    throw new Error("TOR_INSTALL_PATH_MISMATCH");
  const proofPath = path.join(expected, TOR_PROOF);

  if ((await fs.stat(proofPath)).size > 6 * 1024 * 1024) throw new Error("TOR_PROOF_TOO_LARGE");
  // SAFETY: OpenPGP parsing and signature verification reject malformed fields before they authorize any files.
  const proof = JSON.parse(await fs.readFile(proofPath, "utf8")) as { manifest: string; signature: string; key: string };
  const hashes = await verifyTorManifest(proof.manifest, proof.signature, proof.key, pointer.version);
  const hash = hashes.get(getTorAssetName(pointer.version));

  if (!hash) throw new Error("TOR_ARCHIVE_IDENTITY_MISMATCH");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nkc-tor-verify-"));

  try {
    // Copy before checking so extraction never rereads a replaceable installation archive.
    const archive = path.join(temporary, TOR_ARCHIVE);
    await fs.copyFile(path.join(expected, TOR_ARCHIVE), archive);
    await verifySha256(archive, hash);
    await unpackArchive(archive, temporary);
    const authentic = await inventory(temporary);
    const installed = await inventory(expected);

    if (!authentic.has(getBinaryPath("tor")) || authentic.size !== installed.size ||
        [...authentic].some(([name, digest]) => installed.get(name) !== digest))
      throw new Error("TOR_INSTALL_INTEGRITY_MISMATCH");

    return path.join(expected, getBinaryPath("tor"));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
};
