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
    [makePinnedKey({ platform: "android", arch: "arm64", version: "15.0.5", filename: "tor-expert-bundle-android-aarch64-15.0.5.tar.gz" })]: "b9a7cee50aec88e9d138110e635a3159058a01a8e83434efb9cc04a047382f37",
    [makePinnedKey({ platform: "android", arch: "arm", version: "15.0.5", filename: "tor-expert-bundle-android-armv7-15.0.5.tar.gz" })]: "c7403bae19b4658ce47afb51d100eddd6da0ced3b399b12291f2198a46e0fb7e",
    [makePinnedKey({ platform: "android", arch: "ia32", version: "15.0.5", filename: "tor-expert-bundle-android-x86-15.0.5.tar.gz" })]: "310ded3970bee45e0b6448339f57a1144718e696f48129734039dabac7b172d9",
    [makePinnedKey({ platform: "android", arch: "x64", version: "15.0.5", filename: "tor-expert-bundle-android-x86_64-15.0.5.tar.gz" })]: "561487b0c4f3a9ae34239717df98b6ce90d69c7218f5f092125ca99ebdc4570d",
    [makePinnedKey({ platform: "linux", arch: "ia32", version: "15.0.5", filename: "tor-expert-bundle-linux-i686-15.0.5.tar.gz" })]: "fa80379276320a06321ee5b308a6aa289d4440604687f70c1ee6aa55cae679a3",
    [makePinnedKey({ platform: "linux", arch: "x64", version: "15.0.5", filename: "tor-expert-bundle-linux-x86_64-15.0.5.tar.gz" })]: "df5d4850779d9648160c54df1a82733ea54f3430c46b3cc3ed2a22b579f8758e",
    [makePinnedKey({ platform: "darwin", arch: "arm64", version: "15.0.5", filename: "tor-expert-bundle-macos-aarch64-15.0.5.tar.gz" })]: "147be0997f4538c6f20f3a113f6220f7a1c711acc3410f534f0a3cf62b7a06dd",
    [makePinnedKey({ platform: "darwin", arch: "x64", version: "15.0.5", filename: "tor-expert-bundle-macos-x86_64-15.0.5.tar.gz" })]: "38a62c81c93eee88a273a14b8669e7d5a72583adef1c37c28e1cd98ee5ea2ade",
    [makePinnedKey({ platform: "win32", arch: "ia32", version: "15.0.5", filename: "tor-expert-bundle-windows-i686-15.0.5.tar.gz" })]: "7bb25ecb68205c70f34df4e8353e1a1c8951cae82e244177215dbaf1acbc5434",
    [makePinnedKey({ platform: "win32", arch: "x64", version: "15.0.5", filename: "tor-expert-bundle-windows-x86_64-15.0.5.tar.gz" })]: "49aabfe2958c8084e9fba1f78d85049e16a657e1f679b75102bbf9518497607f",
  },
  lokinet: {
    [makePinnedKey({ platform: "linux", arch: "x64", version: "0.9.14", filename: "lokinet-linux-amd64-v0.9.14.tar.xz" })]: "4097f96779a007abf35f37a46394eb5af39debd27244c190ce6867caf7a5115d",
    [makePinnedKey({ platform: "win32", arch: "x64", version: "0.9.11", filename: "lokinet-0.9.11-win64.exe" })]: "0a4a972e1f2d7d2af7f6aebcd15953d98f4ff53b5e823a7d7aa2953eeea2c8d2",
  },
} as const;
