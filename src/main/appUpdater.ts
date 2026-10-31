import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppUpdater, NsisUpdater, UpdateInfo } from "electron-updater";
import { assertUpdateTrust, verifyWindowsUpdateSignature } from "./appUpdaterTrust";
import { verifyGithubUpdate } from "./githubUpdateVerification";

export type AppUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "current" | "error" | "unsupported";
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  releaseNotes?: string;
  error?: string;
};

let status: AppUpdateStatus = {
  state: "idle",
  currentVersion: app.getVersion(),
};

let initialized = false;

let autoUpdater: AppUpdater | null = null;

// Unsigned releases retain the documented manual-install policy.
let updateTrustError: string | undefined = app.isPackaged ? "manual-github-releases" : undefined;
let downloaded: { files: string[]; info: UpdateInfo } | undefined;
let checking: Promise<unknown> | undefined;
let downloading: Promise<AppUpdateStatus> | undefined;
let availableInfo: UpdateInfo | undefined;
let installing = false;

const loadAutoUpdater = () => {
  if (autoUpdater) return autoUpdater;
  const requireFromMain = createRequire(__filename);
  const requireFromUpdater = createRequire(requireFromMain.resolve("electron-updater"));
  const config = requireFromUpdater("js-yaml").load(readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8"));
  assertUpdateTrust(config, process.platform);
  autoUpdater = (requireFromMain("electron-updater") as typeof import("electron-updater")).autoUpdater;
  if (process.platform === "win32") (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = verifyWindowsUpdateSignature;

  return autoUpdater;
};

const isSupported = () =>
  app.isPackaged && !updateTrustError &&
  (process.platform === "win32" ||
    (process.platform === "linux" && Boolean(process.env.APPIMAGE)));

const publishStatus = (patch: Partial<AppUpdateStatus>) => {
  status = { ...status, ...patch, currentVersion: app.getVersion() };

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("appUpdate:status", status);
    }
  }

  return status;
};

const versionFrom = (info: UpdateInfo) => info.version || undefined;

const releaseNotesFrom = (info: UpdateInfo) => {
  if (typeof info.releaseNotes === "string") return info.releaseNotes.trim() || undefined;

  if (!Array.isArray(info.releaseNotes)) return undefined;

  const notes = info.releaseNotes
    .map((note) => note.note?.trim())
    .filter((note): note is string => Boolean(note));

  return notes.length > 0 ? notes.join("\n\n") : undefined;
};

const initialize = () => {
  if (initialized || !isSupported()) return;
  let updater: AppUpdater;
  try { updater = loadAutoUpdater(); }
  catch {
    updateTrustError = "UPDATE_TRUST_INVALID";
    publishStatus({ state: "unsupported", error: updateTrustError });
    return;
  }
  initialized = true;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on("checking-for-update", () => publishStatus({ state: "checking", error: undefined }));
  updater.on("update-available", (info) => {
    availableInfo = info;
    publishStatus({
      state: "available",
      latestVersion: versionFrom(info),
      releaseNotes: releaseNotesFrom(info),
      error: undefined,
    });
  });
  updater.on("update-not-available", (info) =>
    publishStatus({
      state: "current",
      latestVersion: versionFrom(info),
      releaseNotes: releaseNotesFrom(info),
      percent: undefined,
      error: undefined,
    })
  );
  updater.on("download-progress", (progress) =>
    publishStatus({ state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) })
  );
  // downloadUpdate also returns cached files: verify them before exposing installation.
  updater.on("error", (error) =>
    publishStatus({ state: "error", error: error.message || "update-failed" })
  );
};

const checkForUpdates = () => {
  if (checking) return checking;
  if (downloading || downloaded) return Promise.resolve();
  checking = loadAutoUpdater().checkForUpdates().finally(() => { checking = undefined; });
  return checking;
};

const requireSupported = () => {
  if (isSupported()) return;
  publishStatus({
    state: "unsupported",
    error: updateTrustError ?? (app.isPackaged ? "unsupported-install-format" : "packaged-app-required"),
  });
  throw new Error(status.error);
};

export const registerAppUpdaterIpc = (
  assertTrustedIpcSender: (event: IpcMainInvokeEvent) => void
) => {
  initialize();
  ipcMain.handle("appUpdate:getStatus", async (event) => {
    assertTrustedIpcSender(event);

    if (!isSupported()) {
      return publishStatus({
        state: "unsupported",
        error: updateTrustError ?? (app.isPackaged ? "unsupported-install-format" : "packaged-app-required"),
      });
    }

    return status;
  });
  ipcMain.handle("appUpdate:check", async (event) => {
    assertTrustedIpcSender(event);
    requireSupported();
    initialize();
    await checkForUpdates();

    return status;
  });
  ipcMain.handle("appUpdate:download", async (event) => {
    assertTrustedIpcSender(event);
    requireSupported();
    initialize();
    if (downloading) return downloading;
    if (status.state !== "available") throw new Error("update-not-available");
    const info = availableInfo;
    if (!info) throw new Error("update-not-available");
    downloaded = undefined;
    publishStatus({ state: "downloading", percent: 0, error: undefined });
    downloading = (async () => {
      try {
        const files = await loadAutoUpdater().downloadUpdate();
        await verifyGithubUpdate(files, info);
        downloaded = { files, info };
        return publishStatus({ state: "downloaded", latestVersion: info.version, percent: 100, error: undefined });
      } catch (error) {
        publishStatus({ state: "error", percent: undefined, error: error instanceof Error ? error.message : "update-failed" });
        throw error;
      } finally { downloading = undefined; }
    })();
    return downloading;
  });
  ipcMain.handle("appUpdate:install", async (event) => {
    assertTrustedIpcSender(event);
    requireSupported();

    if (installing || status.state !== "downloaded" || !downloaded) throw new Error("update-not-downloaded");
    installing = true;
    try {
      await verifyGithubUpdate(downloaded.files, downloaded.info);
    } catch (error) {
      downloaded = undefined;
      installing = false;
      publishStatus({ state: "error", error: error instanceof Error ? error.message : "update-failed" });
      throw error;
    }
    downloaded = undefined;
    setImmediate(() => loadAutoUpdater().quitAndInstall(false, true));
  });
};

export const scheduleInitialAppUpdateCheck = () => {
  if (!isSupported()) return;
  initialize();
  if (!isSupported()) return;

  const check = () => {
    if (status.state === "checking" || status.state === "downloading" || status.state === "downloaded") return;
    void checkForUpdates().catch(() => undefined);
  };

  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1_000);
};
