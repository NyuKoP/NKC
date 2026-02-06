import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
  defaultAppPrefs,
  normalizePrefs,
  type AppPreferences,
  type AppPreferencesPatch,
} from "../preferences";

const PREFS_FILENAME = "nkc_app_prefs_v1.json";

let cachedPrefs: AppPreferences | null = null;
let pendingWrite: Promise<void> | null = null;

const getPrefsPath = () => path.join(app.getPath("userData"), PREFS_FILENAME);

export const readAppPrefs = async (): Promise<AppPreferences> => {
  if (cachedPrefs) return cachedPrefs;
  try {
    const raw = await fs.readFile(getPrefsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    cachedPrefs = normalizePrefs(parsed);
  } catch {
    cachedPrefs = defaultAppPrefs;
  }
  return cachedPrefs;
};

const writePrefs = async (prefs: AppPreferences) => {
  cachedPrefs = prefs;
  const payload = JSON.stringify({ ...prefs, updatedAt: Date.now() });
  pendingWrite = fs.writeFile(getPrefsPath(), payload, "utf8").finally(() => {
    pendingWrite = null;
  });
  await pendingWrite;
};

export const setAppPrefs = async (patch: AppPreferencesPatch) => {
  const current = await readAppPrefs();
  const next = normalizePrefs({
    ...current,
    ...patch,
    login: { ...current.login, ...(patch.login ?? {}) },
    background: { ...current.background, ...(patch.background ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    deviceSync: { ...current.deviceSync, ...(patch.deviceSync ?? {}) },
  });
  await writePrefs(next);
  return next;
};
