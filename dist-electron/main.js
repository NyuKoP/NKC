"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const promises = require("node:stream/promises");
const crypto = require("node:crypto");
const node_child_process = require("node:child_process");
const net = require("node:net");
const getResponse = async (url, redirects = 0) => {
  if (redirects > 5) {
    throw new Error("Too many redirects");
  }
  const response = await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "nkc-onion-installer" } },
      (res) => resolve(res)
    );
    req.on("error", reject);
  });
  if (response.statusCode && [301, 302, 307, 308].includes(response.statusCode)) {
    const redirect = response.headers.location;
    response.resume();
    if (!redirect) {
      throw new Error("Redirect missing location header");
    }
    return getResponse(redirect, redirects + 1);
  }
  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`Download failed: ${response.statusCode}`);
  }
  return response;
};
const downloadFile = async (url, dest, onProgress) => {
  const request = await getResponse(url);
  const totalBytes = Number(request.headers["content-length"] ?? 0);
  let receivedBytes = 0;
  request.on("data", (chunk) => {
    receivedBytes += chunk.length;
    onProgress?.({ receivedBytes, totalBytes });
  });
  await promises.pipeline(request, fsSync.createWriteStream(dest));
};
const hashFile = async (filePath) => {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
};
const verifySha256 = async (filePath, expectedSha256) => {
  const actual = await hashFile(filePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    const error = new Error(
      `SHA256 mismatch (expected=${expectedSha256.toLowerCase()}, actual=${actual.toLowerCase()})`
    );
    error.expected = expectedSha256;
    error.actual = actual;
    throw error;
  }
};
const unpackArchive = async (archivePath, destDir) => {
  const lowerPath = archivePath.toLowerCase();
  if (lowerPath.endsWith(".zip")) {
    await new Promise((resolve, reject) => {
      if (process.platform === "win32") {
        node_child_process.execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`
          ],
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
        return;
      }
      node_child_process.execFile("unzip", ["-o", archivePath, "-d", destDir], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz") || lowerPath.endsWith(".tar.xz")) {
    await new Promise((resolve, reject) => {
      node_child_process.execFile("tar", ["-xf", archivePath, "-C", destDir], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  throw new Error("Unsupported archive format");
};
const makePinnedKey = (parts) => `${parts.platform}:${parts.arch}:${parts.version}:${parts.filename}`;
const pinnedSha256 = {
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
    [makePinnedKey({ platform: "win32", arch: "x64", version: "15.0.4", filename: "tor-expert-bundle-windows-x86_64-15.0.4.tar.gz" })]: "cce12f8097b1657b56e22ec54cbed4b57fd5f8ff97cc426c21ebd5cc15173924"
  },
  lokinet: {
    [makePinnedKey({ platform: "linux", arch: "x64", version: "0.9.14", filename: "lokinet-linux-amd64-v0.9.14.tar.xz" })]: "4097f96779a007abf35f37a46394eb5af39debd27244c190ce6867caf7a5115d"
  }
};
const withExeSuffix = (platform, basename) => platform === "win32" ? `${basename}.exe` : basename;
const torEntry = {
  id: "tor",
  displayName: "Tor",
  binaryPath: (platform) => path.join("Tor", withExeSuffix(platform, "tor")),
  pinnedSha256: pinnedSha256.tor
};
const lokinetEntry = {
  id: "lokinet",
  displayName: "Lokinet",
  binaryPath: (platform) => withExeSuffix(platform, "lokinet"),
  pinnedSha256: pinnedSha256.lokinet
};
const componentRegistry = {
  tor: torEntry,
  lokinet: lokinetEntry
};
const getBinaryPath = (network, platform = process.platform) => componentRegistry[network].binaryPath(platform);
const getPinnedSha256 = (network, lookup) => {
  const key = makePinnedKey({
    platform: lookup.platform ?? process.platform,
    arch: lookup.arch ?? process.arch,
    version: lookup.version,
    filename: lookup.assetName
  });
  return componentRegistry[network].pinnedSha256[key];
};
const currentFileName = "current.json";
const getComponentRoot = (userDataDir, network) => path.join(userDataDir, "onion", "components", network);
const getPointerPath = (userDataDir, network) => path.join(getComponentRoot(userDataDir, network), currentFileName);
const writeJsonAtomic = async (filePath, data) => {
  const tempPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fs.rename(tempPath, filePath);
};
const readCurrentPointer = async (userDataDir, network) => {
  try {
    const raw = await fs.readFile(getPointerPath(userDataDir, network), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
};
const swapWithRollback = async (userDataDir, network, next) => {
  const previous = await readCurrentPointer(userDataDir, network);
  await writeJsonAtomic(getPointerPath(userDataDir, network), next);
  return async () => {
    if (previous) {
      await writeJsonAtomic(getPointerPath(userDataDir, network), previous);
    }
  };
};
class PinnedHashMissingError extends Error {
  code = "PINNED_HASH_MISSING";
  details;
  constructor(details) {
    super("PINNED_HASH_MISSING");
    this.name = "PinnedHashMissingError";
    this.details = details;
  }
}
const TOR_RELEASE_BASE = "https://dist.torproject.org/torbrowser";
const LOKINET_RELEASE_BASE = "https://github.com/oxen-io/lokinet/releases/download";
const getTorPlatformLabel = (platform) => {
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
const getTorArchLabel = (arch) => {
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
const getTorAssetName = (version, platform = process.platform, arch = process.arch) => `tor-expert-bundle-${getTorPlatformLabel(platform)}-${getTorArchLabel(arch)}-${version}.tar.gz`;
const getTorAssetUrl = (version, platform = process.platform, arch = process.arch) => `${TOR_RELEASE_BASE}/${version}/${getTorAssetName(version, platform, arch)}`;
const getLokinetPlatformLabel = (platform) => {
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
const getLokinetArchLabel = (arch) => {
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
const getLokinetAssetExtension = (platform) => {
  switch (platform) {
    case "linux":
    case "darwin":
      return "tar.xz";
    default:
      return "zip";
  }
};
const getLokinetAssetName = (version, platform = process.platform, arch = process.arch) => `lokinet-${getLokinetPlatformLabel(platform)}-${getLokinetArchLabel(arch)}-v${version}.${getLokinetAssetExtension(
  platform
)}`;
const getLokinetAssetUrlForName = (version, assetName) => `${LOKINET_RELEASE_BASE}/v${version}/${assetName}`;
const resolveDownload$1 = (version) => {
  const assetName = getTorAssetName(version);
  return {
    assetName,
    url: getTorAssetUrl(version)
  };
};
const installTor = async (userDataDir, version, onProgress, downloadUrl, assetNameOverride) => {
  const network = "tor";
  const { assetName, url } = resolveDownload$1(version);
  const resolvedAssetName = assetNameOverride ?? assetName;
  const hash = getPinnedSha256(network, { version, assetName: resolvedAssetName });
  if (!hash) {
    throw new PinnedHashMissingError(
      `Missing pinned hash for Tor asset ${resolvedAssetName} (${version}).`
    );
  }
  const baseOnionDir = path.join(userDataDir, "onion");
  await fs.mkdir(baseOnionDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(baseOnionDir, "tmp-"));
  const resolvedUrl = downloadUrl ?? url;
  const archivePath = path.join(tempDir, resolvedAssetName);
  const installPath = path.join(userDataDir, "onion", "components", network, version);
  const details = {
    network,
    version,
    assetName: resolvedAssetName,
    downloadUrl: resolvedUrl,
    archivePath,
    installPath
  };
  try {
    onProgress?.({ step: "download", message: "Downloading Tor" });
    await downloadFile(
      resolvedUrl,
      archivePath,
      (progress) => onProgress?.({ step: "download", ...progress })
    );
    const stat = await fs.stat(archivePath);
    details.downloadBytes = stat.size;
    onProgress?.({ step: "verify", message: "Verifying Tor" });
    await verifySha256(archivePath, hash);
    details.expectedSha256 = hash;
    await fs.rm(installPath, { recursive: true, force: true });
    await fs.mkdir(installPath, { recursive: true });
    onProgress?.({ step: "unpack", message: "Unpacking Tor" });
    await unpackArchive(archivePath, installPath);
    const binaryPath = path.join(installPath, getBinaryPath(network));
    details.binaryPath = binaryPath;
    if (!fsSync.existsSync(binaryPath)) {
      throw new Error(`BINARY_MISSING: ${binaryPath}`);
    }
    onProgress?.({ step: "activate", message: "Activating Tor" });
    const rollback = await swapWithRollback(userDataDir, network, { version, path: installPath });
    return { version, installPath, rollback };
  } catch (error) {
    if (error && typeof error === "object") {
      const err = error;
      if (err.expected) details.expectedSha256 = err.expected;
      if (err.actual) details.actualSha256 = err.actual;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[onion] Tor install failed", { message, details });
    const wrapped = new Error(`${message} | details=${JSON.stringify(details)}`);
    wrapped.details = details;
    throw wrapped;
  }
};
const resolveDownload = (version, assetNameOverride) => {
  const assetName = assetNameOverride ?? getLokinetAssetName(version);
  return {
    assetName,
    url: getLokinetAssetUrlForName(version, assetName)
  };
};
const installLokinet = async (userDataDir, version, onProgress, downloadUrl, assetNameOverride) => {
  const network = "lokinet";
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
  const details = {
    network,
    version,
    assetName,
    downloadUrl: resolvedUrl,
    archivePath,
    installPath
  };
  onProgress?.({ step: "download", message: "Downloading Lokinet" });
  try {
    await downloadFile(
      resolvedUrl,
      archivePath,
      (progress) => onProgress?.({ step: "download", ...progress })
    );
    const stat = await fs.stat(archivePath);
    details.downloadBytes = stat.size;
    onProgress?.({ step: "verify", message: "Verifying Lokinet" });
    await verifySha256(archivePath, hash);
    details.expectedSha256 = hash;
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
      const err = error;
      if (err.expected) details.expectedSha256 = err.expected;
      if (err.actual) details.actualSha256 = err.actual;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[onion] Lokinet install failed", { message, details });
    const wrapped = new Error(`${message} | details=${JSON.stringify(details)}`);
    wrapped.details = details;
    throw wrapped;
  }
};
class TorManager {
  process = null;
  state = { running: false };
  async start(binaryPath, socksPort, dataDir) {
    if (this.process) return;
    const args = ["--SocksPort", `127.0.0.1:${socksPort}`, "--DataDirectory", dataDir];
    this.process = node_child_process.spawn(binaryPath, args, { stdio: "ignore" });
    this.state = { running: true, pid: this.process.pid };
    this.process.on("exit", () => {
      this.state = { running: false };
      this.process = null;
    });
  }
  async stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.state = { running: false };
  }
  getState() {
    return this.state;
  }
}
class LokinetManager {
  process = null;
  state = { running: false };
  async start(binaryPath, socksPort, dataDir) {
    if (this.process) return;
    const args = ["--socks-port", String(socksPort), "--data-dir", dataDir];
    this.process = node_child_process.spawn(binaryPath, args, { stdio: "ignore" });
    this.state = { running: true, pid: this.process.pid };
    this.process.on("exit", () => {
      this.state = { running: false };
      this.process = null;
    });
  }
  async stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.state = { running: false };
  }
  getState() {
    return this.state;
  }
}
const PORT_START = 9050;
const PORT_END = 9070;
const findAvailablePort = async () => {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    const isFree = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (isFree) return port;
  }
  throw new Error("No available SOCKS port");
};
const waitForPort = async (port, timeoutMs = 3e4) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`SOCKS proxy not ready (port ${port})`);
};
class OnionRuntime {
  torManager = new TorManager();
  lokinetManager = new LokinetManager();
  status = { status: "idle" };
  async start(userDataDir, network) {
    if (this.status.status === "running" && this.status.network === network) return;
    await this.stop();
    this.status = { status: "starting", network };
    try {
      const pointer = await readCurrentPointer(userDataDir, network);
      if (!pointer) {
        throw new Error("Component not installed");
      }
      const port = await findAvailablePort();
      const dataDir = path.join(userDataDir, "onion", "runtime", network);
      await fs.mkdir(dataDir, { recursive: true });
      const binaryPath = path.join(pointer.path, getBinaryPath(network));
      if (!fsSync.existsSync(binaryPath)) {
        throw new Error(`BINARY_MISSING: ${binaryPath}`);
      }
      if (network === "tor") {
        await this.torManager.start(binaryPath, port, dataDir);
      } else {
        await this.lokinetManager.start(binaryPath, port, dataDir);
      }
      await waitForPort(port);
      await electron.session.defaultSession.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
      this.status = { status: "running", network, socksPort: port };
    } catch (error) {
      this.status = {
        status: "failed",
        network,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    }
  }
  async stop() {
    await this.torManager.stop();
    await this.lokinetManager.stop();
    await electron.session.defaultSession.setProxy({ mode: "direct" });
    this.status = { status: "idle" };
  }
  getStatus() {
    return {
      ...this.status,
      tor: this.torManager.getState(),
      lokinet: this.lokinetManager.getState()
    };
  }
}
const fetchJson = async (url) => {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { "User-Agent": "nkc-onion-updater" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Update check failed: ${res.statusCode}`));
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      }
    ).on("error", reject);
  });
};
const fetchText = async (url) => {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "nkc-onion-updater" } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Update check failed: ${res.statusCode}`));
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => resolve(raw));
    }).on("error", reject);
  });
};
const compareVersions = (a, b) => {
  const aParts = a.replace(/^v/i, "").split(".").map(Number);
  const bParts = b.replace(/^v/i, "").split(".").map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }
  return 0;
};
const getPlatformMatchers = () => {
  const platformMatchers = [];
  switch (process.platform) {
    case "win32":
      platformMatchers.push(/win32/i, /windows/i);
      break;
    case "darwin":
      platformMatchers.push(/macos/i, /darwin/i, /osx/i, /mac/i);
      break;
    case "linux":
      platformMatchers.push(/linux/i);
      break;
    case "android":
      platformMatchers.push(/android/i);
      break;
    default:
      platformMatchers.push(new RegExp(process.platform, "i"));
      break;
  }
  const archMatchers = [];
  switch (process.arch) {
    case "x64":
      archMatchers.push(/x86_64/i, /amd64/i);
      break;
    case "ia32":
      archMatchers.push(/i686/i, /x86(?!_64)/i);
      break;
    case "arm64":
      archMatchers.push(/arm64/i, /aarch64/i);
      break;
    case "arm":
      archMatchers.push(/armv7/i, /arm(?!64)/i);
      break;
    default:
      archMatchers.push(new RegExp(process.arch, "i"));
      break;
  }
  return { platformMatchers, archMatchers };
};
const selectReleaseAsset = (assets) => {
  const { platformMatchers, archMatchers } = getPlatformMatchers();
  return assets.find((asset) => {
    if (asset.name.endsWith(".asc") || asset.name.endsWith(".sig")) return false;
    const platformMatch = platformMatchers.some((pattern) => pattern.test(asset.name));
    const archMatch = archMatchers.some((pattern) => pattern.test(asset.name));
    return platformMatch && archMatch;
  });
};
const checkTorUpdates = async () => {
  const indexHtml = await fetchText("https://dist.torproject.org/torbrowser/");
  const versions = Array.from(indexHtml.matchAll(/href="(\d+\.\d+\.\d+)\//g)).map(
    (match) => match[1]
  );
  const latest = versions.sort(compareVersions).at(-1);
  if (!latest) {
    return { version: null, assetName: null, downloadUrl: null, sha256: null };
  }
  const assetName = getTorAssetName(latest);
  const sha256 = getPinnedSha256("tor", { version: latest, assetName });
  if (!sha256) {
    return {
      version: latest,
      assetName,
      downloadUrl: getTorAssetUrl(latest),
      sha256: null,
      errorCode: "PINNED_HASH_MISSING"
    };
  }
  return {
    version: latest,
    assetName,
    downloadUrl: getTorAssetUrl(latest),
    sha256
  };
};
const checkLokinetUpdates = async () => {
  const url = "https://api.github.com/repos/oxen-io/lokinet/releases/latest";
  const release = await fetchJson(url);
  const version = release.tag_name.replace(/^v/i, "");
  const asset = selectReleaseAsset(release.assets);
  if (!asset) {
    return {
      version: null,
      assetName: null,
      downloadUrl: null,
      sha256: null,
      errorCode: "ASSET_NOT_FOUND"
    };
  }
  const sha256 = getPinnedSha256("lokinet", { version, assetName: asset.name });
  if (!sha256) {
    return {
      version,
      assetName: asset.name,
      downloadUrl: asset.browser_download_url,
      sha256: null,
      errorCode: "PINNED_HASH_MISSING"
    };
  }
  return {
    version,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    sha256
  };
};
const checkUpdates = async (network) => {
  if (network === "tor") {
    return checkTorUpdates();
  }
  return checkLokinetUpdates();
};
const isDev = !electron.app.isPackaged;
const isLocalhostProxyUrl = (proxyUrl) => {
  try {
    const parsed = new URL(proxyUrl);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch (error) {
    return false;
  }
};
const applyProxy = async ({ proxyUrl, enabled, allowRemote }) => {
  if (!enabled) {
    await electron.session.defaultSession.setProxy({ mode: "direct" });
    return;
  }
  if (!isLocalhostProxyUrl(proxyUrl) && !allowRemote) {
    throw new Error("Remote proxy URL blocked");
  }
  await electron.session.defaultSession.setProxy({ proxyRules: proxyUrl });
};
const checkProxy = async () => {
  const resolve = await electron.session.defaultSession.resolveProxy("https://example.com");
  const hasProxy = resolve.includes("PROXY") || resolve.includes("SOCKS");
  if (!hasProxy) {
    return { ok: false, message: "proxy-not-applied" };
  }
  return new Promise((resolvePromise) => {
    const request = electron.net.request("https://example.com");
    request.on("response", () => resolvePromise({ ok: true, message: "ok" }));
    request.on("error", () => resolvePromise({ ok: false, message: "unreachable" }));
    request.end();
  });
};
const registerProxyIpc = () => {
  electron.ipcMain.handle("proxy:apply", async (_event, payload) => {
    await applyProxy(payload);
  });
  electron.ipcMain.handle("proxy:check", async () => {
    return checkProxy();
  });
};
const onionRuntime = new OnionRuntime();
const onionComponentCache = {
  tor: { installed: false, status: "idle" },
  lokinet: { installed: false, status: "idle" }
};
const normalizeOnionError = (error, context) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof PinnedHashMissingError ? "PINNED_HASH_MISSING" : message.includes("SHA256 mismatch") ? "HASH_MISMATCH" : message.includes("Download failed") || message.includes("Too many redirects") || message.includes("Redirect") ? "DOWNLOAD_FAILED" : message.includes("Unsupported archive format") || message.includes("tar") || message.includes("unzip") || message.includes("Expand-Archive") ? "EXTRACT_FAILED" : message.includes("BINARY_MISSING") ? "BINARY_MISSING" : (() => {
    const err = error;
    if (err?.code === "EACCES" || err?.code === "EPERM") return "PERMISSION_DENIED";
    if (err?.code === "ENOENT") return "FS_ERROR";
    return "UNKNOWN_ERROR";
  })();
  const details = error && typeof error === "object" && "details" in error ? { ...context, ...error.details } : context;
  return { code, message, details };
};
const refreshComponentState = async (userDataDir, network) => {
  const pointer = await readCurrentPointer(userDataDir, network);
  return {
    ...onionComponentCache[network],
    installed: Boolean(pointer),
    version: pointer?.version
  };
};
const emitOnionProgress = (event, network, status) => {
  event.sender.send("onion:progress", { network, status });
};
const registerOnionIpc = () => {
  electron.ipcMain.handle("onion:status", async () => {
    const userDataDir = electron.app.getPath("userData");
    return {
      components: {
        tor: await refreshComponentState(userDataDir, "tor"),
        lokinet: await refreshComponentState(userDataDir, "lokinet")
      },
      runtime: onionRuntime.getStatus()
    };
  });
  electron.ipcMain.handle("onion:checkUpdates", async () => {
    const userDataDir = electron.app.getPath("userData");
    const torUpdate = await checkUpdates("tor");
    const lokinetUpdate = await checkUpdates("lokinet");
    console.log("[onion] checkUpdates", {
      tor: {
        version: torUpdate.version,
        assetName: torUpdate.assetName,
        downloadUrl: torUpdate.downloadUrl,
        sha256: torUpdate.sha256 ? "<present>" : "<missing>",
        errorCode: torUpdate.errorCode
      },
      lokinet: {
        version: lokinetUpdate.version,
        assetName: lokinetUpdate.assetName,
        downloadUrl: lokinetUpdate.downloadUrl,
        sha256: lokinetUpdate.sha256 ? "<present>" : "<missing>",
        errorCode: lokinetUpdate.errorCode
      }
    });
    const torState = await refreshComponentState(userDataDir, "tor");
    const lokinetState = await refreshComponentState(userDataDir, "lokinet");
    const torHasVerifiedUpdate = Boolean(torUpdate.version && torUpdate.sha256 && torUpdate.downloadUrl);
    const lokinetHasVerifiedUpdate = Boolean(lokinetUpdate.version && lokinetUpdate.sha256 && lokinetUpdate.downloadUrl);
    onionComponentCache.tor = {
      ...torState,
      latest: torHasVerifiedUpdate ? torUpdate.version ?? void 0 : void 0,
      error: torUpdate.errorCode === "PINNED_HASH_MISSING" ? "PINNED_HASH_MISSING" : void 0
    };
    onionComponentCache.lokinet = {
      ...lokinetState,
      latest: lokinetHasVerifiedUpdate ? lokinetUpdate.version ?? void 0 : void 0,
      error: lokinetUpdate.errorCode === "PINNED_HASH_MISSING" ? "PINNED_HASH_MISSING" : void 0
    };
    return {
      components: {
        tor: onionComponentCache.tor,
        lokinet: onionComponentCache.lokinet
      },
      runtime: onionRuntime.getStatus()
    };
  });
  electron.ipcMain.handle("onion:install", async (event, payload) => {
    const userDataDir = electron.app.getPath("userData");
    const network = payload.network;
    let updates = null;
    try {
      updates = await checkUpdates(network);
      if (updates.errorCode === "PINNED_HASH_MISSING") {
        throw new PinnedHashMissingError(
          `Missing pinned hash for ${network} ${updates.assetName ?? updates.version ?? "unknown"}`
        );
      }
      if (!updates.version || !updates.sha256 || !updates.downloadUrl || !updates.assetName) {
        throw new Error("No verified release available");
      }
      onionComponentCache[network] = { ...onionComponentCache[network], status: "downloading" };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const install = network === "tor" ? installTor(
        userDataDir,
        updates.version,
        (progress) => {
          onionComponentCache[network] = {
            ...onionComponentCache[network],
            status: progress.step === "download" ? "downloading" : "installing"
          };
          emitOnionProgress(event, network, onionComponentCache[network]);
        },
        updates.downloadUrl ?? void 0,
        updates.assetName ?? void 0
      ) : installLokinet(
        userDataDir,
        updates.version,
        (progress) => {
          onionComponentCache[network] = {
            ...onionComponentCache[network],
            status: progress.step === "download" ? "downloading" : "installing"
          };
          emitOnionProgress(event, network, onionComponentCache[network]);
        },
        updates.downloadUrl ?? void 0,
        updates.assetName ?? void 0
      );
      const result = await install;
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        installed: true,
        status: "ready",
        version: result.version,
        error: void 0
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
    } catch (error) {
      const context = {
        network,
        version: updates?.version,
        assetName: updates?.assetName,
        downloadUrl: updates?.downloadUrl,
        targetDir: updates?.version ? path.join(userDataDir, "onion", "components", network, updates.version) : void 0
      };
      const normalized = normalizeOnionError(error, context);
      console.error("Onion install failed", {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details
      });
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "failed",
        error: `[${normalized.code}] ${normalized.message}`
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const wrapped = new Error(`[${normalized.code}] ${normalized.message}`);
      wrapped.code = normalized.code;
      wrapped.details = normalized.details;
      throw wrapped;
    }
  });
  electron.ipcMain.handle("onion:applyUpdate", async (event, payload) => {
    const network = payload.network;
    const state = onionComponentCache[network];
    if (!state.latest) {
      throw new Error("No update available");
    }
    const updateInfo = await checkUpdates(network);
    if (updateInfo.errorCode === "PINNED_HASH_MISSING") {
      throw new PinnedHashMissingError(
        `Missing pinned hash for ${network} ${updateInfo.assetName ?? updateInfo.version ?? "unknown"}`
      );
    }
    if (!updateInfo.version || !updateInfo.sha256 || !updateInfo.downloadUrl || !updateInfo.assetName) {
      throw new Error("No verified release available");
    }
    const updateVersion = updateInfo.version ?? state.latest;
    if (!updateVersion) {
      throw new Error("No verified release available");
    }
    const userDataDir = electron.app.getPath("userData");
    try {
      const install = network === "tor" ? installTor(
        userDataDir,
        updateVersion,
        (progress) => {
          onionComponentCache[network] = {
            ...onionComponentCache[network],
            status: progress.step === "download" ? "downloading" : "installing"
          };
          emitOnionProgress(event, network, onionComponentCache[network]);
        },
        updateInfo.downloadUrl ?? void 0,
        updateInfo.assetName ?? void 0
      ) : installLokinet(
        userDataDir,
        updateVersion,
        (progress) => {
          onionComponentCache[network] = {
            ...onionComponentCache[network],
            status: progress.step === "download" ? "downloading" : "installing"
          };
          emitOnionProgress(event, network, onionComponentCache[network]);
        },
        updateInfo.downloadUrl ?? void 0,
        updateInfo.assetName ?? void 0
      );
      const result = await install;
      const runtime = onionRuntime.getStatus();
      if (runtime.status === "running" && runtime.network === network) {
        try {
          await onionRuntime.start(userDataDir, network);
        } catch (error) {
          await result.rollback();
          await onionRuntime.start(userDataDir, network);
          throw error;
        }
      }
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        installed: true,
        status: "ready",
        version: result.version,
        error: void 0
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
    } catch (error) {
      const context = {
        network,
        version: updateVersion,
        assetName: updateInfo.assetName,
        downloadUrl: updateInfo.downloadUrl,
        targetDir: path.join(userDataDir, "onion", "components", network, updateVersion)
      };
      const normalized = normalizeOnionError(error, context);
      console.error("Onion update failed", {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details
      });
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "failed",
        error: `[${normalized.code}] ${normalized.message}`
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const wrapped = new Error(`[${normalized.code}] ${normalized.message}`);
      wrapped.code = normalized.code;
      wrapped.details = normalized.details;
      throw wrapped;
    }
  });
  electron.ipcMain.handle("onion:uninstall", async (_event, payload) => {
    const network = payload.network;
    await onionRuntime.stop();
    const userDataDir = electron.app.getPath("userData");
    const componentRoot = path.join(userDataDir, "onion", "components", network);
    await fs.rm(componentRoot, { recursive: true, force: true });
    onionComponentCache[network] = { installed: false, status: "idle" };
  });
  electron.ipcMain.handle(
    "onion:setMode",
    async (_event, payload) => {
      const userDataDir = electron.app.getPath("userData");
      if (!payload.enabled) {
        await onionRuntime.stop();
        return;
      }
      await onionRuntime.start(userDataDir, payload.network);
    }
  );
};
const rendererUrl = process.env.VITE_DEV_SERVER_URL;
let mainWindow = null;
const canReach = async (url, timeoutMs = 1200) => new Promise((resolve) => {
  try {
    const request = electron.net.request(url);
    const timeout = setTimeout(() => {
      try {
        request.abort();
      } catch {
      }
      resolve(false);
    }, timeoutMs);
    request.on("response", (response) => {
      const ok = Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400);
      response.on("data", () => {
      });
      response.on("end", () => {
        clearTimeout(timeout);
        resolve(ok);
      });
    });
    request.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    request.end();
  } catch (error) {
    resolve(false);
  }
});
const createMainWindow = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const preloadPath = path.join(__dirname, "preload.js");
  const preloadExists = fsSync.existsSync(preloadPath);
  if (isDev && !preloadExists) {
    console.error("[dev] preload missing at", preloadPath);
  }
  const sandboxEnabled = !(isDev && process.env.ELECTRON_DEV_NO_SANDBOX === "1");
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: preloadExists ? preloadPath : void 0,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: sandboxEnabled,
      allowRunningInsecureContent: false
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDesc, validatedURL) => {
    console.error("[main] did-fail-load", errorCode, errorDesc, validatedURL);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main] render-process-gone", details);
  });
  win.webContents.on("unresponsive", () => {
    console.error("[main] renderer unresponsive");
  });
  const safeLog = (...args) => {
    if (!process.stdout || !process.stdout.writable) return;
    try {
      console.log(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EPIPE" || message.includes("EPIPE")) {
        return;
      }
      throw error;
    }
  };
  const ignorePipeError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EPIPE" || message.includes("EPIPE")) {
      return;
    }
    throw error;
  };
  process.stdout?.on("error", ignorePipeError);
  process.stderr?.on("error", ignorePipeError);
  if (isDev) {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (win.webContents.isDestroyed()) return;
      safeLog("[renderer]", level, message, sourceId, line);
    });
  }
  const loadRenderer = async () => {
    if (rendererUrl) {
      console.log("[dev] rendererUrl =", rendererUrl);
      const ok = await canReach(rendererUrl);
      if (ok) {
        console.log("[dev] loadURL =", rendererUrl);
        void win.loadURL(rendererUrl);
        return;
      }
      console.error("[dev] vite not reachable", rendererUrl);
    }
    if (isDev) {
      const fallbackUrl = "http://localhost:5173/";
      const ok = await canReach(fallbackUrl);
      if (ok) {
        console.log("[dev] loadURL =", fallbackUrl);
        void win.loadURL(fallbackUrl);
        return;
      }
      const distIndex = path.join(__dirname, "../dist/index.html");
      if (fsSync.existsSync(distIndex)) {
        console.log("[dev] loadFile =", distIndex);
        void win.loadFile(distIndex);
        return;
      }
      const html = `<!doctype html><html><head><meta charset="utf-8" /><title>Dev Server Unavailable</title></head><body style="font-family:sans-serif;padding:16px;"><h2>Dev server not reachable</h2><p>Start Vite on http://localhost:5173 and reload.</p></body></html>`;
      console.log("[dev] loadURL = dev fallback page");
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return;
    }
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  };
  void loadRenderer();
  if (process.env.OPEN_DEV_TOOLS) {
    win.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow = win;
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
};
const gotTheLock = electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron.app.quit();
  process.exit(0);
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    createMainWindow();
  });
}
if (process.env.VITE_DEV_SERVER_URL) {
  const temp = electron.app.getPath("temp");
  const devRoot = path.join(temp, "nkc-electron-dev");
  const devUserData = path.join(devRoot, "userData");
  const devCache = path.join(devRoot, "cache");
  const devSession = path.join(devRoot, "sessionData");
  const devTemp = path.join(devRoot, "temp");
  fsSync.mkdirSync(devUserData, { recursive: true });
  fsSync.mkdirSync(devCache, { recursive: true });
  fsSync.mkdirSync(devSession, { recursive: true });
  fsSync.mkdirSync(devTemp, { recursive: true });
  electron.app.setPath("userData", devUserData);
  electron.app.setPath("sessionData", devSession);
  electron.app.setPath("temp", devTemp);
  console.log("[dev] userData =", electron.app.getPath("userData"), "temp =", electron.app.getPath("temp"));
}
electron.app.whenReady().then(() => {
  if (isDev) {
    console.log("[main] VITE_DEV_SERVER_URL =", process.env.VITE_DEV_SERVER_URL ?? "");
  }
  registerProxyIpc();
  registerOnionIpc();
  createMainWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
electron.app.on("before-quit", () => console.log("[main] before-quit"));
electron.app.on("will-quit", () => console.log("[main] will-quit"));
electron.app.on("quit", (_event, code) => console.log("[main] quit", code));
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
exports.createMainWindow = createMainWindow;
exports.registerProxyIpc = registerProxyIpc;
//# sourceMappingURL=main.js.map
