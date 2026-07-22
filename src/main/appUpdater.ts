import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater, UpdateInfo } from "electron-updater";

export type AppUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "current" | "error" | "unsupported";
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  releaseNotes?: string;
  error?: string;
};

const CURRENT_RELEASE_NOTES = [
  "앱 업데이트 확인, 다운로드 및 재시작 설치 기능을 추가했습니다.",
  "Tor 번들 고정 해시 자동 갱신과 Windows/macOS 검증을 보강했습니다.",
].join("\n");

let status: AppUpdateStatus = {
  state: "idle",
  currentVersion: app.getVersion(),
  releaseNotes: CURRENT_RELEASE_NOTES,
};
let initialized = false;
let autoUpdater: AppUpdater | null = null;

const loadAutoUpdater = () => {
  if (autoUpdater) return autoUpdater;
  const requireFromMain = createRequire(__filename);
  autoUpdater = (requireFromMain("electron-updater") as typeof import("electron-updater")).autoUpdater;
  return autoUpdater;
};

const isSupported = () =>
  app.isPackaged &&
  (process.platform === "win32" ||
    process.platform === "darwin" ||
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
  initialized = true;
  const updater = loadAutoUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => publishStatus({ state: "checking", error: undefined }));
  updater.on("update-available", (info) =>
    publishStatus({
      state: "available",
      latestVersion: versionFrom(info),
      releaseNotes: releaseNotesFrom(info),
      error: undefined,
    })
  );
  updater.on("update-not-available", (info) =>
    publishStatus({
      state: "current",
      latestVersion: versionFrom(info),
      releaseNotes: releaseNotesFrom(info) ?? CURRENT_RELEASE_NOTES,
      percent: undefined,
      error: undefined,
    })
  );
  updater.on("download-progress", (progress) =>
    publishStatus({ state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) })
  );
  updater.on("update-downloaded", (info) =>
    publishStatus({ state: "downloaded", latestVersion: versionFrom(info), percent: 100, error: undefined })
  );
  updater.on("error", (error) =>
    publishStatus({ state: "error", error: error.message || "update-failed" })
  );
};

const requireSupported = () => {
  if (isSupported()) return;
  publishStatus({
    state: "unsupported",
    error: app.isPackaged ? "unsupported-install-format" : "packaged-app-required",
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
        error: app.isPackaged ? "unsupported-install-format" : "packaged-app-required",
      });
    }
    return status;
  });
  ipcMain.handle("appUpdate:check", async (event) => {
    assertTrustedIpcSender(event);
    requireSupported();
    initialize();
    await loadAutoUpdater().checkForUpdates();
    return status;
  });
  ipcMain.handle("appUpdate:download", async (event) => {
    assertTrustedIpcSender(event);
    requireSupported();
    initialize();
    await loadAutoUpdater().downloadUpdate();
    return status;
  });
  ipcMain.handle("appUpdate:install", async (event) => {
    assertTrustedIpcSender(event);
    if (status.state !== "downloaded") throw new Error("update-not-downloaded");
    setImmediate(() => loadAutoUpdater().quitAndInstall(false, true));
  });
};

export const scheduleInitialAppUpdateCheck = () => {
  if (!isSupported()) return;
  initialize();
  const check = () => {
    if (status.state === "checking" || status.state === "downloading" || status.state === "downloaded") return;
    void loadAutoUpdater().checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1_000);
};
