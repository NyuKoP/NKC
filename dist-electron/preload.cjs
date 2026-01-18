"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("secureProxy", {
  applyProxy: (payload) => electron.ipcRenderer.invoke("proxy:apply", payload),
  checkProxy: () => electron.ipcRenderer.invoke("proxy:check")
});
electron.contextBridge.exposeInMainWorld("onion", {
  install: (payload) => electron.ipcRenderer.invoke("onion:install", payload),
  uninstall: (payload) => electron.ipcRenderer.invoke("onion:uninstall", payload),
  setMode: (payload) => electron.ipcRenderer.invoke("onion:setMode", payload),
  status: () => electron.ipcRenderer.invoke("onion:status"),
  checkUpdates: () => electron.ipcRenderer.invoke("onion:checkUpdates"),
  applyUpdate: (payload) => electron.ipcRenderer.invoke("onion:applyUpdate", payload),
  onProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    electron.ipcRenderer.on("onion:progress", handler);
    return () => electron.ipcRenderer.removeListener("onion:progress", handler);
  }
});
//# sourceMappingURL=preload.cjs.map
