import https from "node:https";
import type { OnionNetwork } from "../../../net/netConfig";
import { getPinnedSha256 } from "../componentRegistry";
import { getTorAssetName, getTorAssetUrl } from "../assetNaming";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name: string;
  assets: ReleaseAsset[];
};

type UpdateCheckResult = {
  version: string | null;
  assetName: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  errorCode?: "PINNED_HASH_MISSING" | "ASSET_NOT_FOUND";
};

const MAX_LOKINET_RELEASE_PAGES = 10;
const LOKINET_RELEASES_PAGE_SIZE = 100;

const fetchJson = async <T,>(url: string): Promise<T> => {
  return new Promise((resolve, reject) => {
    https
      .get(
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
              resolve(JSON.parse(raw) as T);
            } catch (error) {
              reject(error);
            }
          });
        }
      )
      .on("error", reject);
  });
};

const fetchText = async (url: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "nkc-onion-updater" } }, (res) => {
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
      })
      .on("error", reject);
  });
};

export const compareVersions = (a: string, b: string) => {
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
  const platformMatchers: RegExp[] = [];
  switch (process.platform) {
    case "win32":
      platformMatchers.push(/win32/i, /windows/i, /win/i);
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

  const archMatchers: RegExp[] = [];
  switch (process.arch) {
    case "x64":
      archMatchers.push(/x86_64/i, /amd64/i, /win64/i, /64bit/i);
      break;
    case "ia32":
      archMatchers.push(/i686/i, /x86(?!_64)/i, /win32/i, /32bit/i);
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

const selectReleaseAsset = (assets: ReleaseAsset[]) => {
  const { platformMatchers, archMatchers } = getPlatformMatchers();
  return assets.find((asset) => {
    if (asset.name.endsWith(".asc") || asset.name.endsWith(".sig")) return false;
    const platformMatch = platformMatchers.some((pattern) => pattern.test(asset.name));
    const archMatch = archMatchers.some((pattern) => pattern.test(asset.name));
    return platformMatch && archMatch;
  });
};

const fetchReleases = async (page = 1) => {
  const url = `https://api.github.com/repos/oxen-io/lokinet/releases?per_page=${LOKINET_RELEASES_PAGE_SIZE}&page=${page}`;
  return fetchJson<ReleaseResponse[]>(url);
};

type LokinetCandidate = {
  version: string;
  asset: ReleaseAsset;
  sha256: string | null;
};

const toLokinetCandidate = (release: ReleaseResponse): LokinetCandidate | null => {
  const version = release.tag_name.replace(/^v/i, "");
  const asset = selectReleaseAsset(release.assets);
  if (!asset) return null;
  const sha256 = getPinnedSha256("lokinet", {
    version,
    assetName: asset.name,
  });
  return {
    version,
    asset,
    sha256: sha256 ?? null,
  };
};

const findPinnedLokinetCandidate = async (): Promise<LokinetCandidate | null> => {
  for (let page = 1; page <= MAX_LOKINET_RELEASE_PAGES; page += 1) {
    const releases = await fetchReleases(page);
    if (!releases.length) return null;
    for (const release of releases) {
      const candidate = toLokinetCandidate(release);
      if (candidate?.sha256) return candidate;
    }
  }
  return null;
};

const checkTorUpdates = async (): Promise<UpdateCheckResult> => {
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
      errorCode: "PINNED_HASH_MISSING",
    };
  }
  return {
    version: latest,
    assetName,
    downloadUrl: getTorAssetUrl(latest),
    sha256,
  };
};

const checkLokinetUpdates = async (): Promise<UpdateCheckResult> => {
  const url = "https://api.github.com/repos/oxen-io/lokinet/releases/latest";
  const release = await fetchJson<ReleaseResponse>(url);
  const latestCandidate = toLokinetCandidate(release);

  if (latestCandidate?.sha256) {
    return {
      version: latestCandidate.version,
      assetName: latestCandidate.asset.name,
      downloadUrl: latestCandidate.asset.browser_download_url,
      sha256: latestCandidate.sha256,
    };
  }

  if (process.platform === "win32") {
    const fallbackCandidate = await findPinnedLokinetCandidate();
    if (fallbackCandidate?.sha256) {
      return {
        version: fallbackCandidate.version,
        assetName: fallbackCandidate.asset.name,
        downloadUrl: fallbackCandidate.asset.browser_download_url,
        sha256: fallbackCandidate.sha256,
      };
    }
  }

  if (!latestCandidate) {
    return {
      version: release.tag_name.replace(/^v/i, ""),
      assetName: null,
      downloadUrl: null,
      sha256: null,
      errorCode: "ASSET_NOT_FOUND",
    };
  }

  return {
    version: latestCandidate.version,
    assetName: latestCandidate.asset.name,
    downloadUrl: latestCandidate.asset.browser_download_url,
    sha256: null,
    errorCode: "PINNED_HASH_MISSING",
  };
};

export const checkUpdates = async (network: OnionNetwork) => {
  if (network === "tor") {
    return checkTorUpdates();
  }
  return checkLokinetUpdates();
};

export const __testToLokinetCandidate = toLokinetCandidate;
