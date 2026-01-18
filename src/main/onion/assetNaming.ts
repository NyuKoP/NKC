const TOR_RELEASE_BASE = "https://dist.torproject.org/torbrowser";
const LOKINET_RELEASE_BASE = "https://github.com/oxen-io/lokinet/releases/download";

const getTorPlatformLabel = (platform: NodeJS.Platform) => {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "android":
      return "android";
    default:
      return platform;
  }
};

const getTorArchLabel = (arch: NodeJS.Architecture) => {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "ia32":
      return "i686";
    case "arm64":
      return "aarch64";
    case "arm":
      return "armv7";
    default:
      return arch;
  }
};

export const getTorAssetName = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) =>
  `tor-expert-bundle-${getTorPlatformLabel(platform)}-${getTorArchLabel(arch)}-${version}.tar.gz`;

export const getTorAssetUrl = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) => `${TOR_RELEASE_BASE}/${version}/${getTorAssetName(version, platform, arch)}`;

const getLokinetPlatformLabel = (platform: NodeJS.Platform) => {
  switch (platform) {
    case "win32":
      return "win32";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return platform;
  }
};

const getLokinetArchLabel = (arch: NodeJS.Architecture) => {
  switch (arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "i686";
    case "arm64":
      return "arm64";
    default:
      return arch;
  }
};

const getLokinetAssetExtension = (platform: NodeJS.Platform) => {
  switch (platform) {
    case "linux":
    case "darwin":
      return "tar.xz";
    default:
      return "zip";
  }
};

export const getLokinetAssetName = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) =>
  `lokinet-${getLokinetPlatformLabel(platform)}-${getLokinetArchLabel(arch)}-v${version}.${getLokinetAssetExtension(
    platform
  )}`;

export const getLokinetAssetUrl = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) => `${LOKINET_RELEASE_BASE}/v${version}/${getLokinetAssetName(version, platform, arch)}`;

export const getLokinetAssetUrlForName = (version: string, assetName: string) =>
  `${LOKINET_RELEASE_BASE}/v${version}/${assetName}`;
