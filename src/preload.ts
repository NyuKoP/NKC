import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type ProxyHealth = {
  ok: boolean;
  message: string;
};

contextBridge.exposeInMainWorld("electron", {
  secureStorage: {
    isAvailable: () => ipcRenderer.invoke("secretStore:isAvailable") as Promise<boolean>,
    get: (key: string) => ipcRenderer.invoke("secretStore:get", key) as Promise<string | null>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke("secretStore:set", key, value) as Promise<boolean>,
    remove: (key: string) => ipcRenderer.invoke("secretStore:remove", key) as Promise<boolean>,
  },
});

contextBridge.exposeInMainWorld("secureProxy", {
  applyProxy: (payload: { proxyUrl: string; enabled: boolean; allowRemote: boolean }) =>
    ipcRenderer.invoke("proxy:apply", payload) as Promise<void>,
  checkProxy: () => ipcRenderer.invoke("proxy:check") as Promise<ProxyHealth>,
});

contextBridge.exposeInMainWorld("onion", {
  install: (payload: { network: "tor" | "lokinet" }) =>
    ipcRenderer.invoke("onion:install", payload) as Promise<void>,
  uninstall: (payload: { network: "tor" | "lokinet" }) =>
    ipcRenderer.invoke("onion:uninstall", payload) as Promise<void>,
  setMode: (payload: { enabled: boolean; network: "tor" | "lokinet" }) =>
    ipcRenderer.invoke("onion:setMode", payload) as Promise<void>,
  status: () => ipcRenderer.invoke("onion:status") as Promise<unknown>,
  checkUpdates: () => ipcRenderer.invoke("onion:checkUpdates") as Promise<unknown>,
  applyUpdate: (payload: { network: "tor" | "lokinet" }) =>
    ipcRenderer.invoke("onion:applyUpdate", payload) as Promise<void>,
  onProgress: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("onion:progress", handler);
    return () => ipcRenderer.removeListener("onion:progress", handler);
  },
});

contextBridge.exposeInMainWorld("nkc", {
  onionFetch: (req: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke("nkc:onionFetch", req) as Promise<unknown>,
  setOnionProxy: (proxyUrl: string | null) =>
    ipcRenderer.invoke("nkc:setOnionProxy", proxyUrl) as Promise<unknown>,
  getOnionControllerUrl: () =>
    ipcRenderer.invoke("nkc:getOnionControllerUrl") as Promise<string>,
  setOnionForwardProxy: (proxyUrl: string | null) =>
    ipcRenderer.invoke("nkc:setOnionForwardProxy", proxyUrl) as Promise<{ ok: boolean }>,
  onionControllerFetch: (req: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke("nkc:onionControllerFetch", req) as Promise<unknown>,
  getTorStatus: () => ipcRenderer.invoke("nkc:getTorStatus") as Promise<unknown>,
  startTor: () => ipcRenderer.invoke("nkc:startTor") as Promise<unknown>,
  stopTor: () => ipcRenderer.invoke("nkc:stopTor") as Promise<unknown>,
  ensureHiddenService: () => ipcRenderer.invoke("nkc:ensureHiddenService") as Promise<unknown>,
  getMyOnionAddress: () => ipcRenderer.invoke("nkc:getMyOnionAddress") as Promise<string>,
  getLokinetStatus: () => ipcRenderer.invoke("nkc:getLokinetStatus") as Promise<unknown>,
  configureLokinetExternal: (payload: { proxyUrl: string; serviceAddress?: string }) =>
    ipcRenderer.invoke("nkc:configureLokinetExternal", payload) as Promise<unknown>,
  startLokinet: () => ipcRenderer.invoke("nkc:startLokinet") as Promise<unknown>,
  stopLokinet: () => ipcRenderer.invoke("nkc:stopLokinet") as Promise<unknown>,
  getMyLokinetAddress: () => ipcRenderer.invoke("nkc:getMyLokinetAddress") as Promise<string>,
});

contextBridge.exposeInMainWorld("prefs", {
  get: () => ipcRenderer.invoke("prefs:get") as Promise<unknown>,
  set: (patch: unknown) => ipcRenderer.invoke("prefs:set", patch) as Promise<unknown>,
});

contextBridge.exposeInMainWorld("appControls", {
  show: () => ipcRenderer.invoke("app:show") as Promise<void>,
  hide: () => ipcRenderer.invoke("app:hide") as Promise<void>,
  quit: () => ipcRenderer.invoke("app:quit") as Promise<void>,
  syncNow: () => ipcRenderer.invoke("sync:manual") as Promise<void>,
  onSyncStatus: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("sync:status", handler);
    return () => ipcRenderer.removeListener("sync:status", handler);
  },
  onBackgroundStatus: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("background:status", handler);
    return () => ipcRenderer.removeListener("background:status", handler);
  },
});
