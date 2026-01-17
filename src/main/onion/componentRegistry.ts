import path from "node:path";
import type { OnionNetwork } from "../../net/netConfig";
import { makePinnedKey, pinnedSha256 } from "./pinnedHashes";

export type ComponentDownload = {
  version: string;
  assetName: string;
  url: string;
  sha256: string;
};

type ComponentRegistryEntry = {
  id: OnionNetwork;
  displayName: string;
  binaryPath: string;
  pinnedSha256: Record<string, string>;
};

const torEntry: ComponentRegistryEntry = {
  id: "tor",
  displayName: "Tor",
  binaryPath: path.join("Tor", "tor.exe"),
  pinnedSha256: pinnedSha256.tor,
};

const lokinetEntry: ComponentRegistryEntry = {
  id: "lokinet",
  displayName: "Lokinet",
  binaryPath: "lokinet.exe",
  pinnedSha256: pinnedSha256.lokinet,
};

export const componentRegistry: Record<OnionNetwork, ComponentRegistryEntry> = {
  tor: torEntry,
  lokinet: lokinetEntry,
};

export const getBinaryPath = (network: OnionNetwork) => componentRegistry[network].binaryPath;

export type PinnedHashLookup = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  version: string;
  assetName: string;
};

export const getPinnedSha256 = (network: OnionNetwork, lookup: PinnedHashLookup) => {
  const key = makePinnedKey({
    platform: lookup.platform ?? process.platform,
    arch: lookup.arch ?? process.arch,
    version: lookup.version,
    filename: lookup.assetName,
  });
  return componentRegistry[network].pinnedSha256[key];
};
