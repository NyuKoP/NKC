export type SyncStatusPayload = {
  state: "running" | "ok" | "error";
  lastSyncAt: number | null;
  error?: string;
};

export type BackgroundStatusPayload = {
  state: "connected" | "disconnected";
  route?: string;
};

type AppControlsBridge = {
  show: () => Promise<void>;
  hide: () => Promise<void>;
  quit: () => Promise<void>;
  syncNow: () => Promise<void>;
  onSyncStatus: (cb: (payload: SyncStatusPayload) => void) => () => void;
  onBackgroundStatus: (cb: (payload: BackgroundStatusPayload) => void) => () => void;
};

const getBridge = (): AppControlsBridge | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { appControls?: AppControlsBridge };
  return w.appControls ?? null;
};

export const syncNow = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("App controls unavailable");
  await bridge.syncNow();
};

export const onSyncStatus = (cb: (payload: SyncStatusPayload) => void) => {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.onSyncStatus(cb);
};

export const onBackgroundStatus = (cb: (payload: BackgroundStatusPayload) => void) => {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.onBackgroundStatus(cb);
};

export const showApp = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("App controls unavailable");
  await bridge.show();
};

export const hideApp = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("App controls unavailable");
  await bridge.hide();
};

export const quitApp = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("App controls unavailable");
  await bridge.quit();
};
