import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("secureProxy", {
  applyProxy: (payload) => ipcRenderer.invoke("proxy:apply", payload),
  checkProxy: () => ipcRenderer.invoke("proxy:check")
});
contextBridge.exposeInMainWorld("onion", {
  install: (payload) => ipcRenderer.invoke("onion:install", payload),
  uninstall: (payload) => ipcRenderer.invoke("onion:uninstall", payload),
  setMode: (payload) => ipcRenderer.invoke("onion:setMode", payload),
  status: () => ipcRenderer.invoke("onion:status"),
  checkUpdates: () => ipcRenderer.invoke("onion:checkUpdates"),
  applyUpdate: (payload) => ipcRenderer.invoke("onion:applyUpdate", payload),
  onProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("onion:progress", handler);
    return () => ipcRenderer.removeListener("onion:progress", handler);
  }
});
//# sourceMappingURL=preload.js.map
