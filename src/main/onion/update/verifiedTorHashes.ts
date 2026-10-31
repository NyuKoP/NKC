import { createMessage, readKey, readSignature, verify } from "openpgp";
import { getPinnedSha256 } from "../componentRegistry";
import { getTorAssetName } from "../assetNaming";
import { PinnedHashMissingError } from "../errors";

// Same trust anchor as .github/workflows/update-tor-pins.yml.
export const TOR_SIGNING_FINGERPRINT = "EF6E286DDA85EA2A4BA7DE684E2C6E8793298290";

const RELEASE_BASE = "https://dist.torproject.org/torbrowser";

const manifests = new Map<string, ReturnType<typeof loadManifest>>();

export const fetchTorMetadata = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
    headers: { "User-Agent": "nkc-onion-updater" },
  });

  if (!response.ok) throw new Error(`Tor metadata request failed: ${response.status}`);

  if (!response.body) throw new Error("Empty Tor metadata response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.length;

      if (size > 2 * 1024 * 1024) throw new Error("Tor metadata exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }

  return Buffer.concat(chunks).toString("utf8");
};

export const verifyTorManifest = async (
  manifest: string,
  signature: string,
  armoredKey: string,
  version: string,
): Promise<Map<string, string>> => {
  const key = await readKey({ armoredKey });

  if (key.getFingerprint().toUpperCase() !== TOR_SIGNING_FINGERPRINT) {
    throw new Error("Unexpected Tor signing key");
  }

  const result = await verify({
    message: await createMessage({ text: manifest }),
    signature: await readSignature({ armoredSignature: signature }),
    verificationKeys: key,
  });

  if (result.signatures.length === 0) throw new Error("Missing Tor manifest signature");
  await Promise.all(result.signatures.map((entry) => entry.verified));
  const hashes = new Map<string, string>();

  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(tor-expert-bundle-[a-z0-9_-]+-(\d+\.\d+\.\d+)\.tar\.gz)$/i);

    if (!match || match[3] !== version) continue;

    if (hashes.has(match[2])) throw new Error("Duplicate Tor checksum entry");
    hashes.set(match[2], match[1].toLowerCase());
  }

  if (!hashes.size) throw new Error("No matching Tor bundle checksums");

  return hashes;
};

const loadManifest = async (version: string) => {
  const base = `${RELEASE_BASE}/${version}/sha256sums-signed-build.txt`;

  const [manifest, signature, key] = await Promise.all([
    fetchTorMetadata(base),
    fetchTorMetadata(`${base}.asc`),
    fetchTorMetadata(`https://keys.openpgp.org/vks/v1/by-fingerprint/${TOR_SIGNING_FINGERPRINT}`),
  ]);

  const hashes = await verifyTorManifest(manifest, signature, key, version);

  return { manifest, signature, key, hashes };
};

export const getVerifiedTorManifest = async (version: string) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Tor version");

  try {
    let pending = manifests.get(version);

    if (!pending) {
      if (manifests.size >= 4) manifests.delete(manifests.keys().next().value!);
      pending = loadManifest(version);
      manifests.set(version, pending);
    }

    return await pending;
  } catch (error) {
    manifests.delete(version);
    throw error;
  }
};

export const resolveTorHash = async (version: string, assetName: string): Promise<string> => {
  const pinned = getPinnedSha256("tor", { version, assetName });

  if (pinned) return pinned;

  // Reject arbitrary paths and other platforms before making any network request.
  if (!/^\d+\.\d+\.\d+$/.test(version) || assetName !== getTorAssetName(version)) {
    throw new PinnedHashMissingError("Invalid Tor bundle identity");
  }

  try {
    const hash = (await getVerifiedTorManifest(version)).hashes.get(assetName);

    if (!hash) throw new Error("Requested Tor bundle is absent from signed manifest");

    return hash;
  } catch (error) {
    manifests.delete(version); // A later attempt can recover after a network failure.
    throw new PinnedHashMissingError(
      `Could not authenticate Tor checksums: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
