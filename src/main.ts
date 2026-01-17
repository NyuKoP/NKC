import { app, BrowserWindow, ipcMain, net, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ProxyApplyPayload = {
  proxyUrl: string;
  enabled: boolean;
  allowRemote: boolean;
};

type ProxyHealth = {
  ok: boolean;
  message: string;
};

const isLocalhostProxyUrl = (proxyUrl: string) => {
  try {
    const parsed = new URL(proxyUrl);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch (error) {
    return false;
  }
};

const applyProxy = async ({ proxyUrl, enabled, allowRemote }: ProxyApplyPayload) => {
  if (!enabled) {
    await session.defaultSession.setProxy({ mode: "direct" });
    return;
  }
  if (!isLocalhostProxyUrl(proxyUrl) && !allowRemote) {
    throw new Error("Remote proxy URL blocked");
  }
  await session.defaultSession.setProxy({ proxyRules: proxyUrl });
};

const checkProxy = async (): Promise<ProxyHealth> => {
  const resolve = await session.defaultSession.resolveProxy("https://example.com");
  const hasProxy = resolve.includes("PROXY") || resolve.includes("SOCKS");
  if (!hasProxy) {
    return { ok: false, message: "proxy-not-applied" };
  }

  return new Promise((resolvePromise) => {
    const request = net.request("https://example.com");
    request.on("response", () => resolvePromise({ ok: true, message: "ok" }));
    request.on("error", () => resolvePromise({ ok: false, message: "unreachable" }));
    request.end();
  });
};

export const registerProxyIpc = () => {
  ipcMain.handle("proxy:apply", async (_event, payload: ProxyApplyPayload) => {
    await applyProxy(payload);
  });
  ipcMain.handle("proxy:check", async () => {
    return checkProxy();
  });
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.VITE_DEV_SERVER_URL;

export const createMainWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
    },
  });
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  return win;
};

app.whenReady().then(() => {
  registerProxyIpc();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
