import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { MainAccountSession } from "./accounts/mainSessionTypes";

type ProxyHealth = {
  ok: boolean;
  message: string;
};

const P2P_CONNECTION_STATUS_CHANNEL = "p2p:connection-status";

contextBridge.exposeInMainWorld("electron", {
  secureStorage: {
    isAvailable: () => ipcRenderer.invoke("secretStore:isAvailable") as Promise<boolean>,
    get: (key: string) => ipcRenderer.invoke("secretStore:get", key) as Promise<string | null>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke("secretStore:set", key, value) as Promise<boolean>,
    remove: (key: string) => ipcRenderer.invoke("secretStore:remove", key) as Promise<boolean>,
    removeAccount: (accountId: string, session?: MainAccountSession) =>
      ipcRenderer.invoke("secretStore:removeAccount", accountId, session) as Promise<boolean>,
    getOwned: (session: MainAccountSession, key: string) =>
      ipcRenderer.invoke("secretStore:owned:get", session, key) as Promise<string | null>,
    setOwned: (session: MainAccountSession, key: string, value: string, expected?: { value: string | null }) =>
      ipcRenderer.invoke("secretStore:owned:set", session, key, value, expected) as Promise<boolean>,
    removeOwned: (session: MainAccountSession, key: string) =>
      ipcRenderer.invoke("secretStore:owned:remove", session, key) as Promise<boolean>,
    ratchetSnapshot: (accountId: string, channel: string, version: 1 | 2) =>
      ipcRenderer.invoke("secretStore:ratchetSnapshot", accountId, channel, version),
    ratchetCommit: (request: {
      accountId: string; channel: string; version: 1 | 2;
      expectedRevision: number; expectedFingerprint: string | null; nextValue: string;
    }) => ipcRenderer.invoke("secretStore:ratchetCommit", request),
  },
});

contextBridge.exposeInMainWorld("secureProxy", {
  applyProxy: (payload: { proxyUrl: string; enabled: boolean; allowRemote: boolean }) =>
    ipcRenderer.invoke("proxy:apply", payload) as Promise<void>,
  checkProxy: () => ipcRenderer.invoke("proxy:check") as Promise<ProxyHealth>,
});

contextBridge.exposeInMainWorld("onion", {
  install: (payload: { network: "tor" }) =>
    ipcRenderer.invoke("onion:install", payload) as Promise<void>,
  uninstall: (payload: { network: "tor" }) =>
    ipcRenderer.invoke("onion:uninstall", payload) as Promise<void>,
  setMode: (payload: {
    enabled: boolean;
    network: "tor";
    bridgeMode?: "off" | "auto" | "force";
  }) =>
    ipcRenderer.invoke("onion:setMode", payload) as Promise<void>,
  status: () => ipcRenderer.invoke("onion:status") as Promise<unknown>,
  checkUpdates: () => ipcRenderer.invoke("onion:checkUpdates") as Promise<unknown>,
  applyUpdate: (payload: { network: "tor" }) =>
    ipcRenderer.invoke("onion:applyUpdate", payload) as Promise<void>,
  onProgress: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("onion:progress", handler);

    return () => ipcRenderer.removeListener("onion:progress", handler);
  },
});

contextBridge.exposeInMainWorld("nkc", {
  compareRollbackHint: (session: MainAccountSession, root: string, certificates: import("./devices/deviceAuthorization").DeviceAuthorization[]) =>
    ipcRenderer.invoke("freshness:localHint", session, root, certificates),
  activateAccountSession: (accountId: string) =>
    ipcRenderer.invoke("accountSession:activate", accountId) as Promise<MainAccountSession>,
  revokeAccountSession: () => ipcRenderer.invoke("accountSession:revoke") as Promise<void>,
  flushAccountStorage: (session: MainAccountSession) => ipcRenderer.invoke("accountSession:flushStorage", session) as Promise<void>,
  validateAccountSession: (session: MainAccountSession) =>
    ipcRenderer.invoke("accountSession:validate", session) as Promise<boolean>,
  verifyOnionInboxRetention: (session: MainAccountSession, mailboxDeviceId: string, operationId: string, recipientAccount?: string) =>
    ipcRenderer.invoke("nkc:verifyOnionInboxRetention", session, mailboxDeviceId, operationId, recipientAccount) as Promise<boolean>,
  acknowledgeOnionInboxItems: (session: MainAccountSession, mailboxDeviceId: string, itemIds: string[]) =>
    ipcRenderer.invoke("nkc:acknowledgeOnionInboxItems", session, mailboxDeviceId, itemIds) as Promise<boolean>,
  coldStartEnabled: process.env.NKC_COLD_START_TRACE === "1",
  recordColdStartMetric: (metric: unknown) => ipcRenderer.invoke("nkc:recordColdStartMetric", metric) as Promise<void>,
  onionFetch: (req: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke("nkc:onionFetch", req) as Promise<unknown>,
  authorizeOnionFetchOrigin: (url: string) =>
    ipcRenderer.invoke("nkc:authorizeOnionFetchOrigin", url) as Promise<{
      ok: boolean;
      origin?: string;
      error?: string;
    }>,
  setOnionProxy: (proxyUrl: string | null) =>
    ipcRenderer.invoke("nkc:setOnionProxy", proxyUrl) as Promise<unknown>,
  getOnionControllerUrl: () =>
    ipcRenderer.invoke("nkc:getOnionControllerUrl") as Promise<string>,
  registerOnionMailbox: (deviceId: string, session?: MainAccountSession) =>
    ipcRenderer.invoke("nkc:registerOnionMailbox", deviceId, session) as Promise<{
      ok: boolean;
      inboxWriteToken?: string;
      error?: string;
    }>,
  unregisterOnionMailbox: (deviceId: string, session?: MainAccountSession) =>
    ipcRenderer.invoke("nkc:unregisterOnionMailbox", deviceId, session) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  setOnionForwardProxy: (proxyUrl: string | null) =>
    ipcRenderer.invoke("nkc:setOnionForwardProxy", proxyUrl) as Promise<{ ok: boolean }>,
  onionControllerFetch: (req: {
    receiveSession?: MainAccountSession;
    url: string;
    method: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
    bodyPayload?: import("./main/onionController").OnionSendPayload;
    binaryInbox?: boolean;
    timeoutMs?: number;
  }) => ipcRenderer.invoke("nkc:onionControllerFetch", req) as Promise<unknown>,
  confirmOnionApplicationReceipt: (session: MainAccountSession, messageId: string, ciphertext: string | Uint8Array) =>
    ipcRenderer.invoke("nkc:confirmOnionApplicationReceipt", session, messageId, ciphertext) as Promise<boolean>,
  cancelOnionApplicationRetry: (session: MainAccountSession, messageId: string, ciphertext: string | Uint8Array) =>
    ipcRenderer.invoke("nkc:cancelOnionApplicationRetry", session, messageId, ciphertext) as Promise<boolean>,
  supersedeOnionApplicationRetry: (session: MainAccountSession, messageId: string, ciphertext: string | Uint8Array) =>
    ipcRenderer.invoke("nkc:supersedeOnionApplicationRetry", session, messageId, ciphertext) as Promise<boolean>,
  revokeOnionDevice: (session: MainAccountSession, deviceId: string) =>
    ipcRenderer.invoke("nkc:revokeOnionDevice", session, deviceId) as Promise<boolean>,
  // SAFETY: Main parses the request and returns only the bounded permanent-media result contract.
  permanentMedia: (session: MainAccountSession, request: import("./media/permanentMediaTypes").PermanentMediaRequest) =>
    ipcRenderer.invoke("nkc:permanentMedia", session, request) as Promise<import("./media/permanentMediaTypes").PermanentMediaResult>,
  // SAFETY: The trusted Main handler returns only its live Worker instance ID or undefined.
  nativeQueueInstance: (session: MainAccountSession) => ipcRenderer.invoke("nkc:nativeQueueInstance", session) as Promise<string | undefined>,
  prewarmOnionRoute: (payload: { onionAddress: string }) =>
    ipcRenderer.invoke("nkc:prewarmOnionRoute", payload) as Promise<{
      ok: boolean;
      elapsedMs: number;
      error?: string;
    }>,
  getTorStatus: () => ipcRenderer.invoke("nkc:getTorStatus") as Promise<unknown>,
  startTor: (payload?: {
    profileScopedDataDir?: boolean;
    bridgeMode?: "off" | "auto" | "force";
  }) =>
    ipcRenderer.invoke("nkc:startTor", payload) as Promise<unknown>,
  ensureSecondaryTor: (payload?: {
    profileScopedDataDir?: boolean;
    bridgeMode?: "off" | "auto" | "force";
  }) =>
    ipcRenderer.invoke("nkc:ensureSecondaryTor", payload) as Promise<unknown>,
  stopTor: () => ipcRenderer.invoke("nkc:stopTor") as Promise<unknown>,
  checkSocksProxyReachable: (payload: { socksUrl: string; timeoutMs?: number }) =>
    ipcRenderer.invoke("nkc:checkSocksProxyReachable", payload) as Promise<boolean>,
  ensureHiddenService: () => ipcRenderer.invoke("nkc:ensureHiddenService") as Promise<unknown>,
  getMyOnionAddress: () => ipcRenderer.invoke("nkc:getMyOnionAddress") as Promise<string>,
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
  reportSyncResult: (payload: { requestId: string; ok: boolean; error?: string }) => {
    ipcRenderer.send("sync:result", payload);
  },
  onSyncRun: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("sync:run", handler);

    return () => ipcRenderer.removeListener("sync:run", handler);
  },
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

contextBridge.exposeInMainWorld("appUpdate", {
  getStatus: () => ipcRenderer.invoke("appUpdate:getStatus") as Promise<unknown>,
  check: () => ipcRenderer.invoke("appUpdate:check") as Promise<unknown>,
  download: () => ipcRenderer.invoke("appUpdate:download") as Promise<unknown>,
  install: () => ipcRenderer.invoke("appUpdate:install") as Promise<void>,
  onStatus: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on("appUpdate:status", handler);

    return () => ipcRenderer.removeListener("appUpdate:status", handler);
  },
});

contextBridge.exposeInMainWorld("p2p", {
  onConnectionStatus: (cb: (payload: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(P2P_CONNECTION_STATUS_CHANNEL, handler);

    return () => ipcRenderer.removeListener(P2P_CONNECTION_STATUS_CHANNEL, handler);
  },
});

const experimentCapability = ipcRenderer.sendSync("phase2i:capability") as { unifiedText: boolean; recoveryV2: boolean; nativeRatchetCas: boolean; freshnessWitness?: boolean };

contextBridge.exposeInMainWorld("nkcExperimental", {
  ...experimentCapability,
  ...(experimentCapability.recoveryV2 ? { preflight: {
    status: () => ipcRenderer.invoke("phase2q:preflightStatus"),
    prepare: () => ipcRenderer.invoke("phase2q:preflightPrepare"),
  } } : {}),
});

contextBridge.exposeInMainWorld("p2pQueue", {
  phase2iTestProxy: (url: string, nonblockingWake?: boolean) => ipcRenderer.invoke("p2pQueue:phase2iTestProxy", url, nonblockingWake === true),
  list: (accountId: string, session: MainAccountSession) => ipcRenderer.invoke("p2pQueue:list", accountId, session),
  flushNow: (accountId: string, session: MainAccountSession) => ipcRenderer.invoke("p2pQueue:flushNow", accountId, session),
  handoffUnified: (payload: unknown, session: MainAccountSession) => ipcRenderer.invoke("p2pQueue:handoffUnified", payload, session),
  setActiveAccount: (accountId: string, session: MainAccountSession) =>
    ipcRenderer.invoke("p2pQueue:setActiveAccount", accountId, session) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  removeAccount: (accountId: string, managementSession: MainAccountSession) =>
    ipcRenderer.invoke("p2pQueue:removeAccount", accountId, managementSession) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  clearPending: (accountId: string, session: MainAccountSession) =>
    ipcRenderer.invoke("p2pQueue:clearPending", accountId, session) as Promise<{
      ok: boolean;
      removed: number;
      error?: string;
    }>,
});

const preloadToken = ipcRenderer.sendSync("security:get-preload-token") as string | null;

contextBridge.exposeInMainWorld("nativeWorker", {
  inspectFile: (file: File, chunkSize: number) => {
    const filePath = webUtils.getPathForFile(file);

    if (!filePath) return Promise.resolve({ ok: false, error: "file-path-unavailable" });

    return ipcRenderer.invoke("nativeWorker:fileInspect", { path: filePath, chunkSize, token: preloadToken });
  },
  readFileChunk: (file: File, index: number, chunkSize: number) => {
    const filePath = webUtils.getPathForFile(file);

    if (!filePath) return Promise.resolve({ ok: false, error: "file-path-unavailable" });

    return ipcRenderer.invoke("nativeWorker:fileChunk", { path: filePath, index, chunkSize, token: preloadToken });
  },
  receiveInit: (payload: unknown) => ipcRenderer.invoke("nativeWorker:receiveInit", { ...(payload as object), token: preloadToken }),
  receiveWrite: (payload: unknown) => ipcRenderer.invoke("nativeWorker:receiveWrite", { ...(payload as object), token: preloadToken }),
  receiveCheckpoint: (transferId: string) => ipcRenderer.invoke("nativeWorker:receive:checkpoint", { transferId, token: preloadToken }),
  receiveFinalize: (transferId: string) => ipcRenderer.invoke("nativeWorker:receive:finalize", { transferId, token: preloadToken }),
  receiveAbort: (transferId: string) => ipcRenderer.invoke("nativeWorker:receive:abort", { transferId, token: preloadToken }),
  planDelivery: (payload: unknown) => ipcRenderer.invoke("nativeWorker:schedule", payload),
});

contextBridge.exposeInMainWorld("testLog", {
  append: (payload: { channel: string; event: unknown; at?: string }) =>
    ipcRenderer.invoke("testLog:append", payload) as Promise<{ ok: boolean; path: string }>,
  getPath: () => ipcRenderer.invoke("testLog:path") as Promise<string>,
  getFriendFlowPath: () => ipcRenderer.invoke("testLog:friendFlowPath") as Promise<string>,
});
