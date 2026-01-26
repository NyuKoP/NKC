export type SyncIntervalMinutes = 0 | 15 | 30 | 60;

export type AppPreferences = {
  login: {
    autoStartEnabled: boolean;
    startInTray: boolean;
    closeToTray: boolean;
    closeToExit: boolean;
  };
  background: {
    enabled: boolean;
    syncIntervalMinutes: SyncIntervalMinutes;
  };
  notifications: {
    enabled: boolean;
    hideContent: boolean;
  };
};

export type AppPreferencesPatch = {
  login?: Partial<AppPreferences["login"]>;
  background?: Partial<AppPreferences["background"]>;
  notifications?: Partial<AppPreferences["notifications"]>;
};

export const defaultAppPrefs: AppPreferences = {
  login: {
    autoStartEnabled: true,
    startInTray: true,
    closeToTray: true,
    closeToExit: false,
  },
  background: {
    enabled: true,
    syncIntervalMinutes: 30,
  },
  notifications: {
    enabled: true,
    hideContent: true,
  },
};

const allowedIntervals: SyncIntervalMinutes[] = [0, 15, 30, 60];

export const normalizePrefs = (input?: Partial<AppPreferences> | null): AppPreferences => {
  const merged: AppPreferences = {
    login: { ...defaultAppPrefs.login, ...(input?.login ?? {}) },
    background: { ...defaultAppPrefs.background, ...(input?.background ?? {}) },
    notifications: { ...defaultAppPrefs.notifications, ...(input?.notifications ?? {}) },
  };

  if (!allowedIntervals.includes(merged.background.syncIntervalMinutes)) {
    merged.background.syncIntervalMinutes = defaultAppPrefs.background.syncIntervalMinutes;
  }

  if (merged.login.closeToExit) {
    merged.login.closeToTray = false;
    merged.background.enabled = false;
  }

  if (merged.login.closeToTray) {
    merged.login.closeToExit = false;
  }

  return merged;
};

type PrefsBridge = {
  get: () => Promise<AppPreferences>;
  set: (patch: AppPreferencesPatch) => Promise<AppPreferences>;
};

const getBridge = (): PrefsBridge | null => {
  const root = globalThis as typeof globalThis & { prefs?: PrefsBridge };
  return root.prefs ?? null;
};

export const getAppPrefs = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Preferences bridge unavailable");
  return bridge.get();
};

export const setAppPrefs = async (patch: AppPreferencesPatch) => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Preferences bridge unavailable");
  return bridge.set(patch);
};
