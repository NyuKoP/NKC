export type PinnedKeyParts = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  version: string;
  filename: string;
};

export const makePinnedKey = (parts: PinnedKeyParts) =>
  `${parts.platform}:${parts.arch}:${parts.version}:${parts.filename}`;

export const pinnedSha256 = {
  tor: {
    [makePinnedKey({ platform: "android", arch: "arm64", version: "15.0.4", filename: "tor-expert-bundle-android-aarch64-15.0.4.tar.gz" })]: "b1582efca86db843bb4fa435edd766086a77334b32924a72686894212d5e5955",
    [makePinnedKey({ platform: "android", arch: "arm", version: "15.0.4", filename: "tor-expert-bundle-android-armv7-15.0.4.tar.gz" })]: "fdb2d8ed01e40506f1518ef3e5f83a3d62e6f5ac0f8798917532798d6c05771f",
    [makePinnedKey({ platform: "android", arch: "ia32", version: "15.0.4", filename: "tor-expert-bundle-android-x86-15.0.4.tar.gz" })]: "c92f7ffbf105e0ae195e28ac516648b54ba1323f24b47ae236a6d711c7daffe2",
    [makePinnedKey({ platform: "android", arch: "x64", version: "15.0.4", filename: "tor-expert-bundle-android-x86_64-15.0.4.tar.gz" })]: "0adf0201950c02d36897569576eff37718d4afe1835052a3bc424b78be1a0605",
    [makePinnedKey({ platform: "linux", arch: "ia32", version: "15.0.4", filename: "tor-expert-bundle-linux-i686-15.0.4.tar.gz" })]: "228d1a1ccd2683b8c6abc4fd701ebdc7b59254bae47b6acd253cb6aea9338a50",
    [makePinnedKey({ platform: "linux", arch: "x64", version: "15.0.4", filename: "tor-expert-bundle-linux-x86_64-15.0.4.tar.gz" })]: "b9d0cbb76b2d8cca37313393b7b02a931e8b63d58aacbeed18b24d5cbb887fe8",
    [makePinnedKey({ platform: "darwin", arch: "arm64", version: "15.0.4", filename: "tor-expert-bundle-macos-aarch64-15.0.4.tar.gz" })]: "8f0a9dc1020b2d7a89356a6aabefb95663614b132790ea484381ccb669e2d255",
    [makePinnedKey({ platform: "darwin", arch: "x64", version: "15.0.4", filename: "tor-expert-bundle-macos-x86_64-15.0.4.tar.gz" })]: "1577938b499f46b8cdfa6643c4bb982309ee48fcaa08e3d32ac64e2dd8c16830",
    [makePinnedKey({ platform: "win32", arch: "ia32", version: "15.0.4", filename: "tor-expert-bundle-windows-i686-15.0.4.tar.gz" })]: "f1da12f12f0b49ffbbbe99d7a1994b5f7f5e6ced33e4f41d3a520d0d9c445a21",
    [makePinnedKey({ platform: "win32", arch: "x64", version: "15.0.4", filename: "tor-expert-bundle-windows-x86_64-15.0.4.tar.gz" })]: "cce12f8097b1657b56e22ec54cbed4b57fd5f8ff97cc426c21ebd5cc15173924",
  },
  lokinet: {
    [makePinnedKey({ platform: "linux", arch: "x64", version: "0.9.14", filename: "lokinet-linux-amd64-v0.9.14.tar.xz" })]: "4097f96779a007abf35f37a46394eb5af39debd27244c190ce6867caf7a5115d",
  },
} as const;
