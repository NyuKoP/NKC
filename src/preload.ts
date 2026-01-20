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
