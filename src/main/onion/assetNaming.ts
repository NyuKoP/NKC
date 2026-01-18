const TOR_RELEASE_BASE = "https://dist.torproject.org/torbrowser";
const alternateRoute_RELEASE_BASE = "https://github.com/oxen-io/alternateRoute/releases/download";

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

const getalternateRoutePlatformLabel = (platform: NodeJS.Platform) => {
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

const getalternateRouteArchLabel = (arch: NodeJS.Architecture) => {
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

const getalternateRouteAssetExtension = (platform: NodeJS.Platform) => {
  switch (platform) {
    case "linux":
    case "darwin":
      return "tar.xz";
    default:
      return "zip";
  }
};

export const getalternateRouteAssetName = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) =>
  `alternateRoute-${getalternateRoutePlatformLabel(platform)}-${getalternateRouteArchLabel(arch)}-v${version}.${getalternateRouteAssetExtension(
    platform
  )}`;

export const getalternateRouteAssetUrl = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
) => `${alternateRoute_RELEASE_BASE}/v${version}/${getalternateRouteAssetName(version, platform, arch)}`;

export const getalternateRouteAssetUrlForName = (version: string, assetName: string) =>
  `${alternateRoute_RELEASE_BASE}/v${version}/${assetName}`;
