const TOR_RELEASE_BASE = "https://dist.torproject.org/torbrowser";

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
