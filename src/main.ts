import { app, BrowserWindow, ipcMain, net, safeStorage, session } from "electron";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { OnionComponentState, OnionNetwork } from "./net/netConfig";
import { installTor } from "./main/onion/install/installTor";
import { installLokinet } from "./main/onion/install/installLokinet";
import { readCurrentPointer } from "./main/onion/install/swapperRollback";
import { OnionRuntime } from "./main/onion/runtime/onionRuntime";
import { checkUpdates } from "./main/onion/update/checkUpdates";
import { PinnedHashMissingError } from "./main/onion/errors";

type ProxyApplyPayload = {
  proxyUrl: string;
  enabled: boolean;
  allowRemote: boolean;
};

type ProxyHealth = {
  ok: boolean;
  message: string;
};

const isDev = !app.isPackaged;
const SECRET_STORE_FILENAME = "secret-store.json";
const ALLOWED_PROXY_PROTOCOLS = new Set(["socks5:", "socks5h:", "http:", "https:"]);

const isLocalhostHost = (hostname: string) =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

const validateProxyUrl = (input: string) => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Invalid proxy URL");
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error("Invalid proxy URL");
  }
  if (!url.hostname || !url.port) {
    throw new Error("Invalid proxy URL");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy URL");
  }
  return { url, normalized: `${url.protocol}//${url.host}` };
};

const applyProxy = async ({ proxyUrl, enabled, allowRemote }: ProxyApplyPayload) => {
  if (!enabled) {
    await session.defaultSession.setProxy({ mode: "direct" });
    return;
  }
  const { url, normalized } = validateProxyUrl(proxyUrl);
  if (!allowRemote && !isLocalhostHost(url.hostname)) {
    throw new Error("Remote proxy URL blocked");
  }
  await session.defaultSession.setProxy({ proxyRules: normalized });
};

const checkProxy = async (): Promise<ProxyHealth> => {
  const resolve = await session.defaultSession.resolveProxy("https://example.com");
  const hasProxy = resolve.includes("PROXY") || resolve.includes("SOCKS");
  if (!hasProxy) {
    return { ok: false, message: "proxy-not-applied" };
  }

  return new Promise((resolvePromise) => {
    const request = net.request("https://example.com");
    request.on("response", () => resolvePromise({ ok: true, message: "ok" }));
    request.on("error", () => resolvePromise({ ok: false, message: "unreachable" }));
    request.end();
  });
};

export const registerProxyIpc = () => {
  ipcMain.handle("proxy:apply", async (_event, payload: ProxyApplyPayload) => {
    await applyProxy(payload);
  });
  ipcMain.handle("proxy:check", async () => {
    return checkProxy();
  });
};

const readSecretStore = async () => {
  const filePath = path.join(app.getPath("userData"), SECRET_STORE_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code?: unknown }).code ?? "");
      if (code === "ENOENT") return {};
    }
    return {};
  }
};

const writeSecretStore = async (payload: Record<string, string>) => {
  const filePath = path.join(app.getPath("userData"), SECRET_STORE_FILENAME);
  await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
};

const registerSecretStoreIpc = () => {
  ipcMain.handle("secretStore:get", async (_event, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const data = await readSecretStore();
    const entry = data[key];
    if (!entry) return null;
    try {
      return safeStorage.decryptString(Buffer.from(entry, "base64"));
    } catch {
      return null;
    }
  });

  ipcMain.handle("secretStore:set", async (_event, key: string, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return false;
    }
    const data = await readSecretStore();
    const encrypted = safeStorage.encryptString(value);
    data[key] = encrypted.toString("base64");
    await writeSecretStore(data);
    return true;
  });

  ipcMain.handle("secretStore:remove", async (_event, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return false;
    }
    const data = await readSecretStore();
    if (key in data) {
      delete data[key];
      await writeSecretStore(data);
    }
    return true;
  });

  ipcMain.handle("secretStore:isAvailable", async () => {
    return safeStorage.isEncryptionAvailable();
  });
};

type OnionStatusPayload = {
  components: {
    tor: OnionComponentState;
    lokinet: OnionComponentState;
  };
  runtime: ReturnType<OnionRuntime["getStatus"]>;
};

const onionRuntime = new OnionRuntime();
const onionComponentCache: Record<OnionNetwork, OnionComponentState> = {
  tor: { installed: false, status: "idle" },
  lokinet: { installed: false, status: "idle" },
};

const pruneComponentVersions = async (
  userDataDir: string,
  network: OnionNetwork,
  keep: { version: string; installPath: string }
) => {
  const componentsRoot = path.join(userDataDir, "onion", "components", network);
  const normalizedRoot = path.resolve(componentsRoot) + path.sep;
  const normalizedKeep = path.resolve(keep.installPath);
  if (!normalizedKeep.startsWith(normalizedRoot)) return;

  try {
    const entries = await fs.readdir(componentsRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          if (entry.name === keep.version) return;
          await fs.rm(path.join(componentsRoot, entry.name), { recursive: true, force: true });
        })
    );
  } catch {
    // Best-effort cleanup; ignore.
  }
};

const formatProgress = (receivedBytes?: number, totalBytes?: number) => {
  if (!receivedBytes && !totalBytes) return "";
  const total = totalBytes ?? 0;
  if (total > 0) {
    return `${Math.round((receivedBytes ?? 0) / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB`;
  }
  return `${Math.round((receivedBytes ?? 0) / 1024 / 1024)} MB`;
};

const normalizeOnionError = (
  error: unknown,
  context: Record<string, unknown>
) => {
  const message = error instanceof Error ? error.message : String(error);
  const errCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const code =
    error instanceof PinnedHashMissingError
      ? "PINNED_HASH_MISSING"
      : message.includes("SHA256 mismatch")
        ? "HASH_MISMATCH"
        : message.includes("Download failed") ||
            message.includes("Too many redirects") ||
            message.includes("Redirect")
          ? "DOWNLOAD_FAILED"
          : message.includes("Unsupported archive format") ||
              message.includes("tar") ||
              message.includes("unzip") ||
              message.includes("Expand-Archive")
            ? "EXTRACT_FAILED"
            : message.includes("BINARY_MISSING")
              ? "BINARY_MISSING"
              : (() => {
                  const err = error as { code?: string };
                  if (errCode === "EACCES" || errCode === "EPERM") return "PERMISSION_DENIED";
                  if (err?.code === "EACCES" || err?.code === "EPERM") return "PERMISSION_DENIED";
                  if (err?.code === "ENOENT") return "FS_ERROR";
                  return "UNKNOWN_ERROR";
                })();
  const details =
    error && typeof error === "object" && "details" in error
      ? { ...context, ...(error as { details?: Record<string, unknown> }).details }
      : context;
  return { code, message, details };
};

const refreshComponentState = async (userDataDir: string, network: OnionNetwork) => {
  const pointer = await readCurrentPointer(userDataDir, network);
  return {
    ...onionComponentCache[network],
    installed: Boolean(pointer),
    version: pointer?.version,
  };
};

const emitOnionProgress = (
  event: Electron.IpcMainInvokeEvent,
  network: OnionNetwork,
  status: OnionComponentState
) => {
  event.sender.send("onion:progress", { network, status });
};

const registerOnionIpc = () => {
  ipcMain.handle("onion:status", async () => {
    const userDataDir = app.getPath("userData");
    return {
      components: {
        tor: await refreshComponentState(userDataDir, "tor"),
        lokinet: await refreshComponentState(userDataDir, "lokinet"),
      },
      runtime: onionRuntime.getStatus(),
    } satisfies OnionStatusPayload;
  });

  ipcMain.handle("onion:checkUpdates", async () => {
    const userDataDir = app.getPath("userData");
    const torUpdate = await checkUpdates("tor");
    const lokinetUpdate = await checkUpdates("lokinet");
    console.log("[onion] checkUpdates", {
      tor: {
        version: torUpdate.version,
        assetName: torUpdate.assetName,
        downloadUrl: torUpdate.downloadUrl,
        sha256: torUpdate.sha256 ? "<present>" : "<missing>",
        errorCode: torUpdate.errorCode,
      },
      lokinet: {
        version: lokinetUpdate.version,
        assetName: lokinetUpdate.assetName,
        downloadUrl: lokinetUpdate.downloadUrl,
        sha256: lokinetUpdate.sha256 ? "<present>" : "<missing>",
        errorCode: lokinetUpdate.errorCode,
      },
    });
    const torState = await refreshComponentState(userDataDir, "tor");
    const lokinetState = await refreshComponentState(userDataDir, "lokinet");
    const torHasVerifiedUpdate =
      Boolean(torUpdate.version && torUpdate.sha256 && torUpdate.downloadUrl);
    const lokinetHasVerifiedUpdate =
      Boolean(lokinetUpdate.version && lokinetUpdate.sha256 && lokinetUpdate.downloadUrl);
    onionComponentCache.tor = {
      ...torState,
      latest: torHasVerifiedUpdate ? torUpdate.version ?? undefined : undefined,
      error: torUpdate.errorCode === "PINNED_HASH_MISSING" ? "PINNED_HASH_MISSING" : undefined,
      detail:
        torUpdate.errorCode === "PINNED_HASH_MISSING"
          ? `Pinned hash missing for ${torUpdate.assetName ?? torUpdate.version ?? "unknown"}`
          : undefined,
    };
    onionComponentCache.lokinet = {
      ...lokinetState,
      latest: lokinetHasVerifiedUpdate ? lokinetUpdate.version ?? undefined : undefined,
      error:
        lokinetUpdate.errorCode === "PINNED_HASH_MISSING" ? "PINNED_HASH_MISSING" : undefined,
      detail:
        lokinetUpdate.errorCode === "PINNED_HASH_MISSING"
          ? `Pinned hash missing for ${lokinetUpdate.assetName ?? lokinetUpdate.version ?? "unknown"}`
          : undefined,
    };
    return {
      components: {
        tor: onionComponentCache.tor,
        lokinet: onionComponentCache.lokinet,
      },
      runtime: onionRuntime.getStatus(),
    } satisfies OnionStatusPayload;
  });

  ipcMain.handle("onion:install", async (event, payload: { network: OnionNetwork }) => {
    const userDataDir = app.getPath("userData");
    const network = payload.network;
    let updates: Awaited<ReturnType<typeof checkUpdates>> | null = null;
    try {
      updates = await checkUpdates(network);
      if (updates.errorCode === "PINNED_HASH_MISSING") {
        throw new PinnedHashMissingError(
          `Missing pinned hash for ${network} ${updates.assetName ?? updates.version ?? "unknown"}`
        );
      }
      if (!updates.version || !updates.sha256 || !updates.downloadUrl || !updates.assetName) {
        const err = new Error("No verified release available");
        (err as { details?: Record<string, unknown> }).details = {
          network,
          platform: process.platform,
          arch: process.arch,
          update: updates,
        };
        throw err;
      }
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "downloading",
        error: undefined,
        detail: "Preparing download",
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const install =
        network === "tor"
          ? installTor(
              userDataDir,
              updates.version,
              (progress) => {
                onionComponentCache[network] = {
                  ...onionComponentCache[network],
                  status: progress.step === "download" ? "downloading" : "installing",
                  detail:
                    (progress.message ?? "") +
                    (progress.receivedBytes || progress.totalBytes
                      ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                      : ""),
                  progress:
                    progress.receivedBytes || progress.totalBytes
                      ? {
                          receivedBytes: progress.receivedBytes ?? 0,
                          totalBytes: progress.totalBytes ?? 0,
                        }
                      : undefined,
                };
                emitOnionProgress(event, network, onionComponentCache[network]);
              },
              updates.downloadUrl ?? undefined,
              updates.assetName ?? undefined
            )
          : installLokinet(
              userDataDir,
              updates.version,
              (progress) => {
                onionComponentCache[network] = {
                  ...onionComponentCache[network],
                  status: progress.step === "download" ? "downloading" : "installing",
                  detail:
                    (progress.message ?? "") +
                    (progress.receivedBytes || progress.totalBytes
                      ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                      : ""),
                  progress:
                    progress.receivedBytes || progress.totalBytes
                      ? {
                          receivedBytes: progress.receivedBytes ?? 0,
                          totalBytes: progress.totalBytes ?? 0,
                        }
                      : undefined,
                };
                emitOnionProgress(event, network, onionComponentCache[network]);
              },
              updates.downloadUrl ?? undefined,
              updates.assetName ?? undefined
            );
      const result = await install;
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        installed: true,
        status: "ready",
        version: result.version,
        error: undefined,
        detail: `Installed ${result.version}`,
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      await pruneComponentVersions(userDataDir, network, {
        version: result.version,
        installPath: result.installPath,
      });
    } catch (error) {
      const context = {
        network,
        version: updates?.version,
        assetName: updates?.assetName,
        downloadUrl: updates?.downloadUrl,
        targetDir:
          updates?.version
            ? path.join(userDataDir, "onion", "components", network, updates.version)
            : undefined,
      };
      const normalized = normalizeOnionError(error, context);
      console.error("Onion install failed", {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "failed",
        error: `[${normalized.code}] ${normalized.message}`,
        detail: JSON.stringify(normalized.details),
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const wrapped = new Error(`[${normalized.code}] ${normalized.message}`);
      (wrapped as { code?: string; details?: Record<string, unknown> }).code = normalized.code;
      (wrapped as { code?: string; details?: Record<string, unknown> }).details = normalized.details;
      throw wrapped;
    }
  });

  ipcMain.handle("onion:applyUpdate", async (event, payload: { network: OnionNetwork }) => {
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
    const userDataDir = app.getPath("userData");
    try {
      const install =
        network === "tor"
          ? installTor(
              userDataDir,
              updateVersion,
              (progress) => {
                onionComponentCache[network] = {
                  ...onionComponentCache[network],
                  status: progress.step === "download" ? "downloading" : "installing",
                  detail:
                    (progress.message ?? "") +
                    (progress.receivedBytes || progress.totalBytes
                      ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                      : ""),
                  progress:
                    progress.receivedBytes || progress.totalBytes
                      ? {
                          receivedBytes: progress.receivedBytes ?? 0,
                          totalBytes: progress.totalBytes ?? 0,
                        }
                      : undefined,
                };
                emitOnionProgress(event, network, onionComponentCache[network]);
              },
              updateInfo.downloadUrl ?? undefined,
              updateInfo.assetName ?? undefined
            )
          : installLokinet(
              userDataDir,
              updateVersion,
              (progress) => {
                onionComponentCache[network] = {
                  ...onionComponentCache[network],
                  status: progress.step === "download" ? "downloading" : "installing",
                  detail:
                    (progress.message ?? "") +
                    (progress.receivedBytes || progress.totalBytes
                      ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                      : ""),
                  progress:
                    progress.receivedBytes || progress.totalBytes
                      ? {
                          receivedBytes: progress.receivedBytes ?? 0,
                          totalBytes: progress.totalBytes ?? 0,
                        }
                      : undefined,
                };
                emitOnionProgress(event, network, onionComponentCache[network]);
              },
              updateInfo.downloadUrl ?? undefined,
              updateInfo.assetName ?? undefined
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
        error: undefined,
        detail: `Installed ${result.version}`,
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      await pruneComponentVersions(userDataDir, network, {
        version: result.version,
        installPath: result.installPath,
      });
    } catch (error) {
      const context = {
        network,
        version: updateVersion,
        assetName: updateInfo.assetName,
        downloadUrl: updateInfo.downloadUrl,
        targetDir: path.join(userDataDir, "onion", "components", network, updateVersion),
      };
      const normalized = normalizeOnionError(error, context);
      console.error("Onion update failed", {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "failed",
        error: `[${normalized.code}] ${normalized.message}`,
        detail: JSON.stringify(normalized.details),
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      const wrapped = new Error(`[${normalized.code}] ${normalized.message}`);
      (wrapped as { code?: string; details?: Record<string, unknown> }).code = normalized.code;
      (wrapped as { code?: string; details?: Record<string, unknown> }).details = normalized.details;
      throw wrapped;
    }
  });

  ipcMain.handle("onion:uninstall", async (_event, payload: { network: OnionNetwork }) => {
    const network = payload.network;
    await onionRuntime.stop();
    const userDataDir = app.getPath("userData");
    const componentRoot = path.join(userDataDir, "onion", "components", network);
    await fs.rm(componentRoot, { recursive: true, force: true });
    onionComponentCache[network] = { installed: false, status: "idle" };
  });

  ipcMain.handle(
    "onion:setMode",
    async (_event, payload: { enabled: boolean; network: OnionNetwork }) => {
      const userDataDir = app.getPath("userData");
      if (!payload.enabled) {
        await onionRuntime.stop();
        return;
      }
      await onionRuntime.start(userDataDir, payload.network);
    }
  );
};

const rendererUrl = process.env.VITE_DEV_SERVER_URL;
let mainWindow: BrowserWindow | null = null;

const canReach = async (url: string, timeoutMs = 1200) =>
  new Promise<boolean>((resolve) => {
    try {
      const request = net.request(url);
    const timeout = setTimeout(() => {
      try {
        request.abort();
      } catch {
        // intentionally ignored
      }
      resolve(false);
    }, timeoutMs);
      request.on("response", (response) => {
        const ok = Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400);
        response.on("data", () => {});
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
    } catch {
      resolve(false);
    }
  });

export const createMainWindow = () => {
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: preloadExists ? preloadPath : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: sandboxEnabled,
      allowRunningInsecureContent: false,
    },
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
  const safeLog = (...args: unknown[]) => {
    if (!process.stdout || !process.stdout.writable) return;
    try {
      console.log(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "EPIPE" || message.includes("EPIPE")) {
        return;
      }
      throw error;
    }
  };

  const ignorePipeError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
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

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
} else {
  app.on("second-instance", () => {
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
  const temp = app.getPath("temp");
  const devRoot = process.env.NKC_E2E_USER_DATA_DIR || path.join(temp, "nkc-electron-dev");
  const devUserData = path.join(devRoot, "userData");
  const devCache = path.join(devRoot, "cache");
  const devSession = path.join(devRoot, "sessionData");
  const devTemp = path.join(devRoot, "temp");
  fsSync.mkdirSync(devRoot, { recursive: true });
  fsSync.mkdirSync(devUserData, { recursive: true });
  fsSync.mkdirSync(devCache, { recursive: true });
  fsSync.mkdirSync(devSession, { recursive: true });
  fsSync.mkdirSync(devTemp, { recursive: true });
  app.setPath("userData", devUserData);
  app.setPath("sessionData", devSession);
  app.setPath("temp", devTemp);
  console.log("[dev] userData =", app.getPath("userData"), "temp =", app.getPath("temp"));
}

app.whenReady().then(() => {
  if (isDev) {
    console.log("[main] VITE_DEV_SERVER_URL =", process.env.VITE_DEV_SERVER_URL ?? "");
  }
  registerProxyIpc();
  registerSecretStoreIpc();
  registerOnionIpc();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => console.log("[main] before-quit"));
app.on("will-quit", () => console.log("[main] will-quit"));
app.on("quit", (_event, code) => console.log("[main] quit", code));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
