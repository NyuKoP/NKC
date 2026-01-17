import { contextBridge, ipcRenderer } from "electron";

type ProxyHealth = {
  ok: boolean;
  message: string;
};

contextBridge.exposeInMainWorld("secureProxy", {
  applyProxy: (payload: { proxyUrl: string; enabled: boolean; allowRemote: boolean }) =>
    ipcRenderer.invoke("proxy:apply", payload) as Promise<void>,
  checkProxy: () => ipcRenderer.invoke("proxy:check") as Promise<ProxyHealth>,
});
