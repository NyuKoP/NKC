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
  binaryPath: (platform: NodeJS.Platform) => string;
  pinnedSha256: Record<string, string>;
};

const withExeSuffix = (platform: NodeJS.Platform, basename: string) =>
  platform === "win32" ? `${basename}.exe` : basename;

const torEntry: ComponentRegistryEntry = {
  id: "tor",
  displayName: "Tor",
  binaryPath: (platform) => path.join("Tor", withExeSuffix(platform, "tor")),
  pinnedSha256: pinnedSha256.tor,
};

const lokinetEntry: ComponentRegistryEntry = {
  id: "lokinet",
  displayName: "Lokinet",
  binaryPath: (platform) => withExeSuffix(platform, "lokinet"),
  pinnedSha256: pinnedSha256.lokinet,
};

export const componentRegistry: Record<OnionNetwork, ComponentRegistryEntry> = {
  tor: torEntry,
  lokinet: lokinetEntry,
};

export const getBinaryPath = (network: OnionNetwork, platform: NodeJS.Platform = process.platform) =>
  componentRegistry[network].binaryPath(platform);

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
