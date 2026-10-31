import { beginSessionInvestigation, readSessionInvestigation, countSessionStage } from "./diagnostics/sessionInvestigation";

if (process.env.NKC_E2E === "1" && process.env.NKC_SESSION_INVESTIGATION_LOCAL === "1") {
  beginSessionInvestigation();
  Object.defineProperty(globalThis, "__nkcLocalSessionCounters", { value: readSessionInvestigation });
}

import { isLocalhostHost, validateProxyUrl } from "./net/proxyUrl";
import { sanitizeRoutingHints } from "./net/privacy";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  Menu,
  Tray,
  nativeImage,
  safeStorage,
} from "electron";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import nodeNet from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OnionComponentState, OnionNetwork } from "./net/netConfig";
import {
  ONION_CONTROLLER_MAX_BODY_BASE64_BYTES,
} from "./net/mediaTransferLimits";
import { installTor } from "./main/onion/install/installTor";
import { runInstallSingleFlight } from "./main/onion/install/installSingleFlight";
import { removeWithRetry } from "./main/onion/install/removeWithRetry";
import { removeTorInstallationArtifacts } from "./main/onion/install/cleanupTor";
import { readCurrentPointer } from "./main/onion/install/swapperRollback";
import { getBinaryPath } from "./main/onion/componentRegistry";
import { OnionRuntime } from "./main/onion/runtime/onionRuntime";
import {
  selectUnifiedOnionRuntimeStatus,
  type OnionRuntimeStatus,
} from "./main/onion/runtime/unifiedRuntimeStatus";
import { checkUpdates } from "./main/onion/update/checkUpdates";
import { activateUpdate } from "./main/onion/update/activateUpdate";
import { PinnedHashMissingError } from "./main/onion/errors";
import { startOnionController, type OnionControllerHandle } from "./main/onionController";
import {
  NativeOfflineQueueManager,
  type OfflineQueueManager,
} from "./main/nativeOfflineQueueManager";
import { NativeWorkerClient } from "./main/nativeWorkerClient";
import { createNativeSocksTransport } from "./main/socksHttpClient";
import { TorManager } from "./main/torManager";
import { coldStartTelemetry as cold } from "./main/coldStartTelemetry";
import { ColdStartRendererMetrics } from "./main/coldStartRendererMetrics";
import { OnionStartup } from "./main/onionStartup";
import { readAppPrefs, setAppPrefs } from "./main/preferences";
import { registerNativeWorkerIpc, resetPreloadToken } from "./main/ipc/nativeWorkerIpc";
import { registerCapabilityIpc } from "./main/ipc/capabilityIpc";
import { registerP2PQueueIpc } from "./main/ipc/p2pQueueIpc";
import { registerPermanentMediaIpc } from "./main/ipc/permanentMediaIpc";
import { authorizeDisposableRatchetProfile, authorizeDisposableRecoveryProfile, authorizeDisposableNativeOwnerProfile } from "./main/disposableRatchetProfile";
import { configureNativeRatchetOwner } from "./main/services/secretStore";
import { createPhase2QPreflight } from "./main/phase2qPreflight";
import { registerSecretStoreIpc } from "./main/ipc/secretStoreIpc";
import { waitForStorageKeyPersistence } from "./main/storageKeyPersistence";
import { RollbackHintStore } from "./main/freshness/rollbackHint";
import { AccountSessionAuthority, bindAccountSessionLifecycle } from "./main/accountSessionAuthority";
import type { MainAccountSession } from "./accounts/mainSessionTypes";

import { registerTestLogIpc } from "./main/ipc/testLogIpc";
import { defaultAppPrefs, type AppPreferences, type AppPreferencesPatch } from "./preferences";
import { fetchWithTimeout } from "./net/fetchWithTimeout";
import { createSafeConsole } from "./diagnostics/safeConsole";
import { shouldUseDevRuntime } from "./main/runtimeMode";
import { blockSpellcheckerDownloads, configureOnionSessionProxy, onionSessionFetch } from "./main/onionSessionPolicy";
import {
  isTrustedRendererUrlForRuntime,
  resolveTrustedMainFrameUrl,
} from "./main/rendererTrust";
import { registerAppUpdaterIpc, scheduleInitialAppUpdateCheck } from "./main/appUpdater";

const accountSessions = new AccountSessionAuthority();

cold.mark("app.module_loaded");

const coldRendererMetrics = new ColdStartRendererMetrics();

declare const __NKC_NATIVE_WORKER_SHA256__: string;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "nkc-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

// Every session, including the default one created at ready, must not fetch dictionaries.
app.on("session-created", blockSpellcheckerDownloads);

export { resetPreloadToken } from "./main/ipc/nativeWorkerIpc";

export { loadKeyPair, saveKeyPair } from "./main/services/secretStore";

const console = createSafeConsole(globalThis.console);

type ProxyApplyPayload = {
  proxyUrl: string;
  enabled: boolean;
  allowRemote: boolean;
};

type ProxyHealth = {
  ok: boolean;
  message: string;
};

type OnionFetchRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
};

type OnionFetchResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
};

const MAX_ONION_FETCH_HEADER_COUNT = 32;

const MAX_ONION_FETCH_HEADER_VALUE_BYTES = 8 * 1024;

const ALLOWED_ONION_FETCH_METHODS = new Set(["GET", "POST", "PUT"]);

const BLOCKED_FORWARD_HEADERS = new Set([
  "connection",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_APPROVED_FETCH_ORIGINS = new Set(["https://rendezvous.nkc.im"]);

let approvedFetchOrigins = new Set(DEFAULT_APPROVED_FETCH_ORIGINS);

const approvedFetchOriginsPath = () =>
  path.join(app.getPath("userData"), "approved-network-origins.json");

const normalizeApprovableOrigin = (value: string) => {
  const parsed = new URL(value);

  if (parsed.username || parsed.password) throw new Error("credentials-in-url-blocked");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const isOnion = hostname.endsWith(".onion");

  if (isOnion && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { origin: parsed.origin, isOnion: true };
  }

  if (parsed.protocol !== "https:") throw new Error("https-required");

  if (isBlockedNetworkHost(hostname)) throw new Error("private-network-origin-blocked");

  return { origin: parsed.origin, isOnion: false };
};

const loadApprovedFetchOrigins = async () => {
  approvedFetchOrigins = new Set(DEFAULT_APPROVED_FETCH_ORIGINS);

  try {
    const raw = await fs.readFile(approvedFetchOriginsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) return;

    for (const candidate of parsed) {
      if (typeof candidate !== "string") continue;

      try {
        const normalized = normalizeApprovableOrigin(candidate);

        if (!normalized.isOnion) approvedFetchOrigins.add(normalized.origin);
      } catch {
        // Ignore invalid or obsolete entries.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[security] failed to read approved network origins");
    }
  }
};

const persistApprovedFetchOrigins = async () => {
  const target = approvedFetchOriginsPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify([...approvedFetchOrigins].sort()), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
};

const isApprovedOnionFetchUrl = (value: string) => {
  try {
    const normalized = normalizeApprovableOrigin(value);

    return normalized.isOnion || approvedFetchOrigins.has(normalized.origin);
  } catch {
    return false;
  }
};

const validateOnionFetchRequest = (req: OnionFetchRequest) => {
  if (!req || typeof req.url !== "string" || typeof req.method !== "string") {
    throw new Error("invalid-request");
  }

  if (!isApprovedOnionFetchUrl(req.url)) throw new Error("blocked-url");
  const method = req.method.toUpperCase();

  if (!ALLOWED_ONION_FETCH_METHODS.has(method)) throw new Error("blocked-method");

  if ((req.bodyBase64?.length ?? 0) > ONION_CONTROLLER_MAX_BODY_BASE64_BYTES) {
    throw new Error("request-body-too-large");
  }

  if (
    req.timeoutMs !== undefined &&
    (!Number.isFinite(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > 30_000)
  ) {
    throw new Error("invalid-timeout");
  }

  const headers = req.headers ?? {};
  const entries = Object.entries(headers);

  if (entries.length > MAX_ONION_FETCH_HEADER_COUNT) throw new Error("too-many-headers");

  for (const [name, value] of entries) {
    const normalizedName = name.trim().toLowerCase();

    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalizedName) ||
      BLOCKED_FORWARD_HEADERS.has(normalizedName) ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_ONION_FETCH_HEADER_VALUE_BYTES ||
      /[\r\n]/.test(value)
    ) {
      throw new Error("invalid-header");
    }
  }

  return { ...req, method, headers };
};

type OnionControllerFetchRequest = {
  receiveSession?: MainAccountSession;
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  bodyPayload?: import("./main/onionController").OnionSendPayload;
  binaryInbox?: boolean;
  timeoutMs?: number;
};

type OnionControllerFetchResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyPayload?: ReturnType<OnionControllerHandle["readInboxItems"]>;
  error?: string;
};

type StartTorPayload = {
  profileScopedDataDir?: boolean;
  bridgeMode?: "off" | "auto" | "force";
};

const ONION_CONTROLLER_NOT_READY_MESSAGE = "Onion Controller가 초기화되지 않았습니다.";

type IpcErrorResponse = {
  ok: false;
  success: false;
  error: string;
};

const createIpcError = (error: string): IpcErrorResponse => ({
  ok: false,
  success: false,
  error,
});

const requireOnionNetwork = (value: unknown): OnionNetwork => {
  if (value === "tor") return value;
  throw new Error("invalid-onion-network");
};

const isTrustedRendererUrl = (url: string) => {
  return isTrustedRendererUrlForRuntime(url, {
    isDev,
    isPackaged: app.isPackaged,
    rendererUrl,
    distIndexPath: path.resolve(__dirname, "../dist/index.html"),
  });
};

const isBlockedNetworkHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0") return true;

  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);

  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;

  if (/^169\.254\./.test(normalized) || /^fc/i.test(normalized) || /^fd/i.test(normalized)) return true;

  return false;
};

const isAllowedLocalSocksUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = Number.parseInt(parsed.port, 10);

    return (
      (parsed.protocol === "socks5:" || parsed.protocol === "socks5h:") &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") &&
      !parsed.username &&
      !parsed.password &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      !parsed.search &&
      !parsed.hash &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    );
  } catch {
    return false;
  }
};

const isTrustedIpcSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
  const url = resolveTrustedMainFrameUrl({
    senderFrame: event.senderFrame,
    senderUrl: event.sender.getURL(),
  });

  return url !== null && isTrustedRendererUrl(url);
};

const assertTrustedIpcSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
  if (!isTrustedIpcSender(event)) {
    const frameUrl = event.senderFrame?.url || "<empty>";
    const senderUrl = event.sender.getURL() || "<empty>";
    const frameKind = event.senderFrame?.parent ? "child" : "top";
    throw new Error(
      `Blocked IPC from untrusted renderer (frame=${frameKind}, frameUrl=${frameUrl}, senderUrl=${senderUrl}, packaged=${app.isPackaged}, dev=${isDev})`
    );
  }
};

type SyncStatusPayload = {
  state: "running" | "ok" | "error";
  lastSyncAt: number | null;
  error?: string;
};

type BackgroundStatusPayload = {
  state: "connected" | "disconnected";
  route?: string;
};

type SyncRunPayload = {
  requestId: string;
  reason: "manual" | "interval";
};

type SyncResultPayload = {
  requestId: string;
  ok: boolean;
  error?: string;
};

const rendererUrl = process.env.VITE_DEV_SERVER_URL;

const isDev = shouldUseDevRuntime({ isPackaged: app.isPackaged, rendererUrl });

const isAutoStartLaunch = process.argv.includes("--autostart");

let onionSession: Electron.Session | null = null;

const getOnionSession = () => {
  if (!onionSession) {
    onionSession = session.fromPartition("persist:nkc-onion-fetch");
    onionSession.setPermissionCheckHandler(() => false);
    onionSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  }

  return onionSession;
};

const isProxyApplyPayload = (payload: unknown): payload is ProxyApplyPayload =>
  Boolean(
    payload &&
      typeof payload === "object" &&
      typeof (payload as ProxyApplyPayload).proxyUrl === "string" &&
      typeof (payload as ProxyApplyPayload).enabled === "boolean" &&
      typeof (payload as ProxyApplyPayload).allowRemote === "boolean"
  );

const applyProxy = async ({ proxyUrl, enabled, allowRemote }: ProxyApplyPayload) => {
  if (!enabled) {
    await session.defaultSession.setProxy({ mode: "direct" });

    return;
  }

  const { url, normalized } = validateProxyUrl(proxyUrl);

  if (!allowRemote && !isLocalhostHost(url.hostname)) {
    throw new Error("Remote proxy URL blocked");
  }

  await session.defaultSession.setProxy({ proxyRules: normalized });
};

const setOnionProxy = async (proxyUrl: string | null) => {
  await configureOnionSessionProxy(getOnionSession(), proxyUrl);
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
  ipcMain.handle("proxy:apply", async (event, payload: ProxyApplyPayload) => {
    assertTrustedIpcSender(event);

    if (!isProxyApplyPayload(payload)) {
      throw new Error("Invalid proxy payload");
    }

    await applyProxy(payload);
  });
  ipcMain.handle("proxy:check", async (event) => {
    assertTrustedIpcSender(event);

    return checkProxy();
  });
};

const collectHeaders = (headers: Headers | Record<string, string[] | string | undefined>) => {
  const out: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });

    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }

  return out;
};

const decodeBase64 = (value: string) => Buffer.from(value, "base64");

const encodeBase64 = (value: Uint8Array) => Buffer.from(value).toString("base64");

const createAbortTraceId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const emitAbortTrace = (
  event: "abort:linked" | "abort:fired",
  detail: Record<string, unknown>
) => {
  if (event === "abort:linked") {
    const opId = typeof detail.opId === "string" ? detail.opId : "";

    if (opId.includes("/onion/inbox")) {
      return;
    }
  }

  console.info(`[trace][${event}]`, {
    ...detail,
    ts: new Date().toISOString(),
  });
};

const fetchViaNetRequest = async (req: OnionFetchRequest): Promise<OnionFetchResponse> => {
  return new Promise((resolve) => {
    try {
      const request = net.request({
        method: req.method,
        url: req.url,
        session: getOnionSession(),
        redirect: "error",
      });

      if (req.headers) {
        for (const [key, value] of Object.entries(req.headers)) {
          request.setHeader(key, value);
        }
      }

      const timeoutMs = req.timeoutMs ?? 10000;
      const abortId = `main-abort:${createAbortTraceId()}`;
      emitAbortTrace("abort:linked", {
        abortId,
        opId: req.url,
        source: "timeout",
      });

      const timeout = setTimeout(() => {
        try {
          request.abort();
        } catch {
          // ignore abort errors
        }

        emitAbortTrace("abort:fired", {
          abortId,
          opId: req.url,
          source: "timeout",
          reason: `net.request timeout ${timeoutMs}ms`,
        });
        resolve({
          ok: false,
          status: 0,
          headers: {},
          bodyBase64: "",
          error: "timeout",
        });
      }, timeoutMs);

      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          clearTimeout(timeout);
          const body = Buffer.concat(chunks);
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: collectHeaders(response.headers),
            bodyBase64: body.toString("base64"),
          });
        });
      });
      request.on("error", (error) => {
        clearTimeout(timeout);
        resolve({
          ok: false,
          status: 0,
          headers: {},
          bodyBase64: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });

      if (req.bodyBase64) {
        request.write(decodeBase64(req.bodyBase64));
      }

      request.end();
    } catch (error) {
      resolve({
        ok: false,
        status: 0,
        headers: {},
        bodyBase64: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

const fetchViaNetFetch = async (req: OnionFetchRequest): Promise<OnionFetchResponse> => {
  const timeoutMs = req.timeoutMs ?? 10000;

  try {
    const response = await fetchWithTimeout<{
      ok: boolean;
      status: number;
      headers: Headers;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }>(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        body: req.bodyBase64 ? decodeBase64(req.bodyBase64) : undefined,
      },
      {
        timeoutMs,
        opId: req.url,
        traceSource: "timeout",
        onTrace: (trace) => {
          emitAbortTrace(trace.event, {
            abortId: trace.abortId,
            opId: trace.opId,
            source: trace.source,
            reason: trace.reason,
          });
        },
        fetchImpl: (url, init) => onionSessionFetch(getOnionSession(), url, init),
      }
    );

    const buffer = new Uint8Array(await response.arrayBuffer());

    return {
      ok: response.ok,
      status: response.status,
      headers: collectHeaders(response.headers),
      bodyBase64: encodeBase64(buffer),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      status: 0,
      headers: {},
      bodyBase64: "",
      error: message,
    };
  }
};

const registerOnionFetchIpc = () => {
  ipcMain.handle("nkc:setOnionProxy", async (event, proxyUrl: string | null) => {
    assertTrustedIpcSender(event);

    if (proxyUrl !== null && (!proxyUrl.trim() || !isAllowedLocalSocksUrl(proxyUrl))) {
      throw new Error("Blocked non-local SOCKS proxy URL");
    }

    await setOnionProxy(proxyUrl);

    return { ok: true };
  });
  ipcMain.handle("nkc:authorizeOnionFetchOrigin", async (event, value: string) => {
    assertTrustedIpcSender(event);

    if (typeof value !== "string") return { ok: false, error: "invalid-origin" };
    let normalized: { origin: string; isOnion: boolean };

    try {
      normalized = normalizeApprovableOrigin(value);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "invalid-origin" };
    }

    if (normalized.isOnion || approvedFetchOrigins.has(normalized.origin)) {
      return { ok: true, origin: normalized.origin };
    }

    const parent = BrowserWindow.fromWebContents(event.sender);

    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Cancel", "Allow"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Allow custom network server",
      message: `Allow NKC to send encrypted rendezvous traffic to ${normalized.origin}?`,
      detail: "Only approve a server you operate or explicitly trust.",
    };

    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);

    if (result.response !== 1) return { ok: false, error: "origin-not-approved" };
    approvedFetchOrigins.add(normalized.origin);
    await persistApprovedFetchOrigins();

    return { ok: true, origin: normalized.origin };
  });
  ipcMain.handle("nkc:onionFetch", async (event, req: OnionFetchRequest) => {
    assertTrustedIpcSender(event);
    let validated: OnionFetchRequest;

    try {
      validated = validateOnionFetchRequest(req);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        headers: {},
        bodyBase64: "",
        error: error instanceof Error ? error.message : "invalid-request",
      } satisfies OnionFetchResponse;
    }

    try {
      // This session is separate from the Controller/Worker Tor route. Configure it
      // before each request so an unconfigured or stale session cannot use DIRECT.
      if (!currentTorSocksProxy || !isAllowedLocalSocksUrl(currentTorSocksProxy)) {
        throw new Error("Onion SOCKS proxy unavailable");
      }

      await setOnionProxy(currentTorSocksProxy);
      const route = await getOnionSession().resolveProxy(validated.url);

      if (!/^SOCKS5\s+[^;]+$/i.test(route.trim())) {
        throw new Error("Onion SOCKS proxy not applied");
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        headers: {},
        bodyBase64: "",
        error: error instanceof Error ? error.message : "Onion SOCKS proxy unavailable",
      } satisfies OnionFetchResponse;
    }

    if (typeof getOnionSession().fetch === "function") {
      return fetchViaNetFetch(validated);
    }

    return fetchViaNetRequest(validated);
  });
};

const fetchOnionController = async (
  req: OnionControllerFetchRequest,
  owner?: { accountId: string; sessionToken?: string; assertCurrent: () => void }
): Promise<OnionControllerFetchResponse> => {
  if (
    !req ||
    typeof req.url !== "string" ||
    !req.url ||
    typeof req.method !== "string" ||
    !req.method
  ) {
    return { status: 0, headers: {}, bodyBase64: "", error: "invalid-request" };
  }

  let requestUrl: URL;
  let controllerOrigin: string;

  try {
    requestUrl = new URL(req.url);
    controllerOrigin = new URL(onionControllerUrl).origin;
  } catch {
    return { status: 0, headers: {}, bodyBase64: "", error: "blocked-controller-url" };
  }

  const allowedRoutes = new Map([
    ["/onion/health", "GET"],
    ["/onion/address", "GET"],
    ["/onion/send", "POST"],
    ["/onion/inbox", "GET"],
  ]);

  const requestMethod = req.method.toUpperCase();
  const expectedMethod = allowedRoutes.get(requestUrl.pathname);
  const bodyBase64Length = req.bodyBase64?.length ?? 0;

  const blockReason =
    requestUrl.origin !== controllerOrigin
      ? "blocked-controller-origin"
      : expectedMethod !== requestMethod
        ? "blocked-controller-route"
        : bodyBase64Length > ONION_CONTROLLER_MAX_BODY_BASE64_BYTES
          ? `controller-request-body-too-large:${bodyBase64Length}:${ONION_CONTROLLER_MAX_BODY_BASE64_BYTES}`
          : null;

  if (blockReason) {
    console.warn("[controller-fetch] blocked", {
      originMatches: requestUrl.origin === controllerOrigin,
      pathname: requestUrl.pathname,
      requestMethod,
      expectedMethod: expectedMethod ?? null,
      bodyBase64Length,
      maxBodyBase64Length: ONION_CONTROLLER_MAX_BODY_BASE64_BYTES,
    });

    return { status: 0, headers: {}, bodyBase64: "", error: blockReason };
  }

  if (!onionController?.authToken) {
    return { status: 0, headers: {}, bodyBase64: "", error: ONION_CONTROLLER_NOT_READY_MESSAGE };
  }

  const timeoutMs = Math.min(70_000, Math.max(1, req.timeoutMs ?? 10000));

  try {
    if (req.binaryInbox) {
      if (requestUrl.pathname !== "/onion/inbox" || !owner || requestUrl.searchParams.has("after")) {
        return { status: 403, headers: {}, bodyBase64: "", error: "invalid-binary-inbox-owner" };
      }

      const token = new Headers(req.headers).get("X-NKC-Mailbox-Token") ?? "";

      const result = onionController.readInboxItems(requestUrl.searchParams.get("deviceId") ?? "", token,
        Number(requestUrl.searchParams.get("scanAfter") ?? "-1"), Number(requestUrl.searchParams.get("limit") ?? "50"), owner);

      return { status: result.ok ? 200 : 403, headers: {}, bodyBase64: "", bodyPayload: result, error: result.error };
    }
    if (requestUrl.pathname === "/onion/send") {
      if (req.bodyPayload && req.bodyBase64) throw new Error("ambiguous-controller-body");
      const payload = req.bodyPayload ?? JSON.parse(Buffer.from(req.bodyBase64 ?? "", "base64").toString("utf8"));
      const result = await onionController.send(payload, owner);
      owner?.assertCurrent();

      return { status: result.status, headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify(result.body)).toString("base64") };
    }

    const response = await fetchWithTimeout(
      req.url,
      {
        method: requestMethod,
        headers: {
          ...req.headers,
          "X-NKC-Controller-Token": onionController.authToken,
        },
        body: req.bodyBase64 ? decodeBase64(req.bodyBase64) : undefined,
        redirect: "error",
      },
      {
        timeoutMs,
        opId: req.url,
        traceSource: "timeout",
        onTrace: (trace) => {
          emitAbortTrace(trace.event, {
            abortId: trace.abortId,
            opId: trace.opId,
            source: trace.source,
            reason: trace.reason,
          });
        },
      }
    );

    const buffer = new Uint8Array(await response.arrayBuffer());

    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      bodyBase64: encodeBase64(buffer),
    };
  } catch (error) {
    return {
      status: 0,
      headers: {},
      bodyBase64: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const checkSocksProxyReachable = async (socksUrl: string, timeoutMs = 2000) => {
  let parsed: URL;

  try {
    parsed = new URL(socksUrl);
  } catch {
    return false;
  }

  if (!parsed.hostname) return false;
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 0;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = nodeNet.connect({
      host: parsed.hostname,
      port,
    });

    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(Math.max(1, timeoutMs));
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
};

const registerOnionControllerIpc = () => {
  ipcMain.handle("nkc:recordColdStartMetric", (event, payload: unknown) => {
    assertTrustedIpcSender(event);
    coldRendererMetrics.record(payload);
  });
  ipcMain.handle("nkc:getOnionControllerUrl", async (event) => {
    assertTrustedIpcSender(event);

    return onionControllerUrl;
  });
  ipcMain.handle("nkc:registerOnionMailbox", async (event, deviceId: string, session: MainAccountSession) => {
    assertTrustedIpcSender(event);

    if (!onionController) {
      return { ok: false, error: ONION_CONTROLLER_NOT_READY_MESSAGE };
    }

    const owner = accountSessions.assertCurrent(event.sender.id, session);

    return onionController.registerMailbox(deviceId, { owner: {
      accountId: owner.accountId,
      assertCurrent: () => { accountSessions.assertCurrent(event.sender.id, session); },
    } });
  });
  ipcMain.handle("nkc:unregisterOnionMailbox", async (event, deviceId: string, session: MainAccountSession) => {
    assertTrustedIpcSender(event);

    if (!onionController) {
      return { ok: false, error: ONION_CONTROLLER_NOT_READY_MESSAGE };
    }

    const owner = accountSessions.assertCurrent(event.sender.id, session);

    return onionController.unregisterMailbox(deviceId, { accountId: owner.accountId,
      assertCurrent: () => { accountSessions.assertCurrent(event.sender.id, session); } });
  });
  ipcMain.handle("nkc:setOnionForwardProxy", async (event, proxyUrl: string | null) => {
    assertTrustedIpcSender(event);

    if (!onionController) {
      return createIpcError(ONION_CONTROLLER_NOT_READY_MESSAGE);
    }

    if (proxyUrl !== null && (!proxyUrl.trim() || !isAllowedLocalSocksUrl(proxyUrl))) {
      return createIpcError("Blocked non-local SOCKS proxy URL");
    }

    currentTorSocksProxy = proxyUrl?.trim() ? proxyUrl.trim() : null;
    await onionController.setTorSocksProxies(
      [currentTorSocksProxy, secondaryTorSocksProxy].filter(
        (value): value is string => Boolean(value)
      ), currentTorSocksProxy
    );
    p2pQueueManager?.updateProxyUrl(currentTorSocksProxy);

    return { ok: true, success: true };
  });
  ipcMain.handle("nkc:onionControllerFetch", async (event, req: OnionControllerFetchRequest) => {
    assertTrustedIpcSender(event);

    if (!onionController) {
      return {
        status: 0,
        headers: {},
        bodyBase64: "",
        error: ONION_CONTROLLER_NOT_READY_MESSAGE,
      } satisfies OnionControllerFetchResponse;
    }

    let requestUrl: URL;

    try { requestUrl = new URL(req.url); }
    catch { return fetchOnionController(req); }

    const mailbox = requestUrl.pathname === "/onion/inbox" ? requestUrl.searchParams.get("deviceId") : null;

    if (mailbox) countSessionStage("main-poll", "input");
    const accountId = mailbox ? onionController.getMailboxOwner(mailbox) : undefined;
    const session = accountId ? accountSessions.assertCurrent(event.sender.id, req.receiveSession!) : undefined;

    if (session && session.accountId !== accountId) {
      // Inactive-owner inspection must never acknowledge/remove an inbox prefix.
      requestUrl.searchParams.delete("after");
      req = { ...req, url: requestUrl.toString() };
    }

    const sendSession = (requestUrl.pathname === "/onion/send" || req.binaryInbox) && req.receiveSession
      ? accountSessions.assertCurrent(event.sender.id, req.receiveSession) : undefined;

    const response = await fetchOnionController(req, sendSession ? {
      accountId: sendSession.accountId,
      sessionToken: sendSession.token,
      assertCurrent: () => { accountSessions.assertCurrent(event.sender.id, sendSession); },
    } : undefined);

    if (session && mailbox && response.status === 200) {
      accountSessions.assertCurrent(event.sender.id, session);
      const payload = response.bodyPayload ?? JSON.parse(Buffer.from(response.bodyBase64, "base64").toString("utf8"));

      countSessionStage("main-poll", "success");
      countSessionStage("main-inbox", "input", (payload.items ?? []).length);

      for (const item of payload.items ?? []) {
        countSessionStage("main-inbox", item.admission === "authenticated" ? "success" : "rejected");

        if (item.admission === "authenticated") item.localOwner = {
          accountId, session, mailboxDeviceId: mailbox, operationId: item.id, expiresAt: item.expiresAt,
        };
      }

      if (session.accountId !== accountId && !requestUrl.searchParams.has("scanAfter")) payload.nextAfter = null;

      if (!response.bodyPayload) response.bodyBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    }

    return response;
  });
  ipcMain.handle("nkc:verifyOnionInboxRetention", (event, session: MainAccountSession, mailbox: string, operationId: string, recipientAccount?: string) => {
    assertTrustedIpcSender(event);

    if (!onionController || typeof mailbox !== "string" || typeof operationId !== "string") return false;
    const accountId = onionController.getMailboxOwner(mailbox);

    if (!accountId || accountId !== (recipientAccount ?? session?.accountId)) return false;
    accountSessions.assertCurrent(event.sender.id, session);

    return onionController.hasRetainedInboxItem(mailbox, operationId);
  });
  ipcMain.handle("nkc:acknowledgeOnionInboxItems", (event, session: MainAccountSession, mailbox: string, itemIds: string[]) => {
    assertTrustedIpcSender(event);

    if (!onionController || typeof mailbox !== "string") return false;
    const owner = accountSessions.assertCurrent(event.sender.id, session);

    return onionController.acknowledgeInboxItems(mailbox, itemIds, {
      accountId: owner.accountId,
      assertCurrent: () => { accountSessions.assertCurrent(event.sender.id, session); },
    });
  });
  ipcMain.handle("nkc:revokeOnionDevice", async (event, session: MainAccountSession, deviceId: unknown) => {
    assertTrustedIpcSender(event);
    const owner = accountSessions.assertCurrent(event.sender.id, session);

    if (!nativeWorkerClient || typeof deviceId !== "string" || !sanitizeRoutingHints({ deviceId })?.deviceId) return false;
    await nativeWorkerClient.request("queue.revokeDevice", { accountId: owner.accountId, deviceId });
    accountSessions.assertCurrent(event.sender.id, session);

    return true;
  });
  ipcMain.handle("nkc:prewarmOnionRoute", async (event, payload: { onionAddress?: string }) => {
    assertTrustedIpcSender(event);

    if (!onionController || typeof payload?.onionAddress !== "string") {
      return { ok: false, elapsedMs: 0, error: ONION_CONTROLLER_NOT_READY_MESSAGE };
    }

    const end = cold.begin("prewarm.ipc.begin", {
      target: payload.onionAddress.trim().toLowerCase() === myOnionAddress ? "self" : "other",
    });

    try {
      const result = await onionController.prewarmTorRoute(payload.onionAddress);
      end("prewarm.ipc.end", result.ok ? "ok" : "failed");

      return result;
    } catch (error) {
      end("prewarm.ipc.end", "failed");
      throw error;
    }
  });
  ipcMain.handle("nkc:getTorStatus", async (event) => {
    assertTrustedIpcSender(event);

    return {
      ...(torManager?.getStatus() ?? { state: "unavailable" }),
      hiddenServiceState: hiddenServiceReadiness,
    };
  });
  ipcMain.handle("nkc:startTor", async (event, payload?: StartTorPayload) => {
    assertTrustedIpcSender(event);

    if (phase2qPreflight && phase2qPreflight.status() !== "verified") throw new Error("PREFLIGHT_REQUIRED");
    const end = cold.begin("tor.ipc_start.begin", { lane: "primary" });

    try {
      await waitForOnionBackend();
      await torManager!.start(payload);
    } finally {
      end("tor.ipc_start.end", torManager?.getStatus().state === "running" ? "ok" : "failed");
    }

    if (torManager?.getStatus().state === "running") {
      void ensurePrimaryHiddenService().catch((error) => {
        console.warn("[tor] hidden service preparation failed", error);
      });
    }

    return { ok: true };
  });
  ipcMain.handle("nkc:ensureSecondaryTor", async (event, payload?: StartTorPayload) => {
    assertTrustedIpcSender(event);

    if (phase2qPreflight && phase2qPreflight.status() !== "verified") throw new Error("PREFLIGHT_REQUIRED");

    return startSecondaryTor(payload);
  });
  ipcMain.handle("nkc:stopTor", async (event) => {
    assertTrustedIpcSender(event);

    if (!torManager) return { ok: false };
    await Promise.all([torManager.stop(), torSecondaryManager?.stop()]);

    return { ok: true };
  });
  ipcMain.handle(
    "nkc:checkSocksProxyReachable",
    async (event, payload: { socksUrl?: string; timeoutMs?: number }) => {
      assertTrustedIpcSender(event);

      if (!payload?.socksUrl || typeof payload.socksUrl !== "string") return false;

      if (!isAllowedLocalSocksUrl(payload.socksUrl)) return false;
      const timeoutMs = Math.min(10_000, Math.max(1, payload.timeoutMs ?? 2000));

      return checkSocksProxyReachable(payload.socksUrl, timeoutMs);
    }
  );
  ipcMain.handle("nkc:ensureHiddenService", async (event) => {
    assertTrustedIpcSender(event);
    const onionHost = await ensurePrimaryHiddenService();

    return { ok: true, success: true, onionHost };
  });
  ipcMain.handle("nkc:getMyOnionAddress", async (event) => {
    assertTrustedIpcSender(event);

    return myOnionAddress ?? "";
  });
};

const registerAppIpc = () => {
  ipcMain.handle("prefs:get", async (event) => {
    assertTrustedIpcSender(event);

    return readAppPrefs();
  });
  ipcMain.handle("prefs:set", async (event, patch: AppPreferencesPatch) => {
    assertTrustedIpcSender(event);
    const next = await setAppPrefs(patch ?? {});
    await applyPrefs(next);

    return next;
  });
  ipcMain.handle("sync:manual", async (event) => {
    assertTrustedIpcSender(event);
    await backgroundService?.manualSync();
  });
  ipcMain.on("sync:result", (event, payload: SyncResultPayload) => {
    if (!isTrustedIpcSender(event)) return;

    if (!payload || typeof payload !== "object") return;

    if (!payload.requestId || typeof payload.requestId !== "string") return;
    const pending = pendingSyncRuns.get(payload.requestId);

    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSyncRuns.delete(payload.requestId);

    if (payload.ok) {
      pending.resolve();

      return;
    }

    pending.reject(new Error(payload.error || "sync-failed"));
  });
  ipcMain.handle("app:show", async (event) => {
    assertTrustedIpcSender(event);

    if (!focusMainWindow()) createMainWindow();
  });
  ipcMain.handle("app:hide", async (event) => {
    assertTrustedIpcSender(event);
    mainWindow?.hide();
  });
  ipcMain.handle("app:quit", async (event) => {
    assertTrustedIpcSender(event);
    isQuitting = true;
    app.quit();
  });
};

type OnionStatusPayload = {
  components: {
    tor: OnionComponentState;
  };
  runtime: OnionRuntimeStatus;
};

const onionRuntime = new OnionRuntime();

const onionComponentCache: Record<OnionNetwork, OnionComponentState> = {
  tor: { installed: false, status: "idle" },
};

let onionController: OnionControllerHandle | null = null;

let onionControllerUrl = "";

let torManager: TorManager | null = null;

let torSecondaryManager: TorManager | null = null;

let myOnionAddress: string | null = null;

let p2pQueueManager: OfflineQueueManager | null = null;

let nativeWorkerClient: NativeWorkerClient | null = null;

let onionStartup: OnionStartup | null = null;

let currentTorSocksProxy: string | null = null;

let secondaryTorSocksProxy: string | null = null;

type HiddenServiceReadiness = "idle" | "preparing" | "ready" | "failed";

let hiddenServiceReadiness: HiddenServiceReadiness = "idle";

let hiddenServicePreparation: Promise<string> | null = null;

let secondaryTorStartPromise: Promise<{ ok: boolean; state: string }> | null = null;


let shutdownInProgress: Promise<void> | null = null;

let runtimeShutdownComplete = false;

const ensureOnionBackend = async () => {
  if (!onionStartup || shutdownInProgress) throw new Error(ONION_CONTROLLER_NOT_READY_MESSAGE);
  const backend = await onionStartup.ensureReady();

  if (shutdownInProgress) throw new Error(ONION_CONTROLLER_NOT_READY_MESSAGE);
  nativeWorkerClient = backend.worker;
  p2pQueueManager = backend.queue;
  onionController = backend.controller;
  onionControllerUrl = backend.controller.baseUrl;
};

const waitForOnionBackend = async () => {
  const end = cold.begin("tor.dependencies.begin", { lane: "primary" });

  try {
    await ensureOnionBackend();
    end("tor.dependencies.end", "ok");
  } catch (error) {
    end("tor.dependencies.end", "failed");
    throw error;
  }
};

const initializeOnionManagers = () => {
  const userDataPath = app.getPath("userData");
  const primary = new TorManager({ appDataDir: userDataPath });
  const secondary = new TorManager({ appDataDir: userDataPath, instanceId: "lane-2" });
  torManager = primary;
  torSecondaryManager = secondary;

  const syncTorProxyPool = () => onionController?.setTorSocksProxies(
    [currentTorSocksProxy, secondaryTorSocksProxy].filter((value): value is string => Boolean(value)), currentTorSocksProxy
  );

  // Listeners belong to the managers, not to a fallible worker/controller attempt.
  primary.onStatus((status) => {
    currentTorSocksProxy = status.state === "running" ? status.socksProxyUrl : null;
    p2pQueueManager?.updateProxyUrl(currentTorSocksProxy);
    void syncTorProxyPool();
    emitRuntimeBackgroundStatus({
      state: status.state === "running" ? "connected" : "disconnected",
      route: status.state === "running" ? "Tor Network" : status.state === "starting" ? "Tor starting" : "Tor offline",
    });
  });
  secondary.onStatus((status) => {
    secondaryTorSocksProxy = status.state === "running" ? status.socksProxyUrl : null;
    void syncTorProxyPool();
  });
  onionStartup = new OnionStartup({
    createWorker: () => {
      const executableName = process.platform === "win32" ? "nkc-worker.exe" : "nkc-worker";

      const executablePath = (!app.isPackaged ? process.env.NKC_GO_WORKER_PATH : undefined) ||
        (app.isPackaged ? path.join(process.resourcesPath, "native", executableName)
          : path.join(process.cwd(), "native", "bin", executableName));

      return new NativeWorkerClient(executablePath, __NKC_NATIVE_WORKER_SHA256__.trim().toLowerCase());
    },
    createQueue: (worker) => NativeOfflineQueueManager.create(worker,
      path.join(userDataPath, "p2p-offline-queue-go.json"), path.join(userDataPath, "p2p-offline-queue.json"),
      10_000, () => coldRendererMetrics.queueDiagnosticId(), () => coldRendererMetrics.queueDiagnosticKind()),
    createController: async (worker, queue) => {
      const options = {
        getTorStatus: () => primary.getStatus(), userDataPath, queueOnFailure: true,
        onInboundDiagnostic: (envelope: string, stage: "controller_received" | "controller_accepted") => coldRendererMetrics.inbound(envelope, stage),
        socksTransport: createNativeSocksTransport(worker, { getAccountId: () => queue.getActiveAccountId(),
          onForwardResult: (payload, result) => {
            coldRendererMetrics.nativeResult(payload, result);
          } }),
      };

      try { return await startOnionController({ ...options, port: 3210 }); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")) throw error;

        return startOnionController({ ...options, port: 0 });
      }
    },
    configureHiddenService: (controller) => primary.configureHiddenService({ localPort: controller.port, virtPort: 80 }),
  });
};

const ensurePrimaryHiddenService = async () => {
  if (phase2qPreflight && phase2qPreflight.status() !== "verified") throw new Error("PREFLIGHT_REQUIRED");

  if (myOnionAddress) {
    hiddenServiceReadiness = "ready";

    return myOnionAddress;
  }

  if (hiddenServicePreparation) return hiddenServicePreparation;
  await waitForOnionBackend();

  if (hiddenServicePreparation) return hiddenServicePreparation;

  if (myOnionAddress) return myOnionAddress;

  if (!torManager || !onionController) {
    throw new Error(ONION_CONTROLLER_NOT_READY_MESSAGE);
  }

  hiddenServiceReadiness = "preparing";
  hiddenServicePreparation = torManager
    .ensureHiddenService({
      localPort: onionController.port,
      virtPort: 80,
    })
    .then((result) => {
      myOnionAddress = result.onionHost;
      onionController?.setTorOnionHost(result.onionHost);
      hiddenServiceReadiness = "ready";

      return result.onionHost;
    })
    .catch((error) => {
      hiddenServiceReadiness = "failed";
      throw error;
    })
    .finally(() => {
      hiddenServicePreparation = null;
    });

  return hiddenServicePreparation;
};

const startSecondaryTor = async (payload?: StartTorPayload) => {
  await ensureOnionBackend();

  if (!torSecondaryManager) {
    return Promise.resolve({ ok: false, state: "unavailable" });
  }

  const currentState = torSecondaryManager.getStatus().state;

  if (currentState === "running") {
    return Promise.resolve({ ok: true, state: currentState });
  }

  if (secondaryTorStartPromise) return secondaryTorStartPromise;
  secondaryTorStartPromise = torSecondaryManager
    .start(payload)
    .then(() => {
      const state = torSecondaryManager?.getStatus().state ?? "unavailable";

      return { ok: state === "running", state };
    })
    .finally(() => {
      secondaryTorStartPromise = null;
    });

  return secondaryTorStartPromise;
};

const getUnifiedOnionRuntimeStatus = () =>
  selectUnifiedOnionRuntimeStatus(
    onionRuntime.getStatus(),
    torManager?.getStatus() ?? null
  );

const shutdownBackgroundRuntimes = async () => {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = (async () => {
    cold.mark("app.shutdown.begin");
    p2pQueueManager?.stop();
    await Promise.allSettled([
      onionStartup?.close(),
      torManager?.stop(),
      torSecondaryManager?.stop(),
    ]);
    nativeWorkerClient = null;
    currentTorSocksProxy = null;
    secondaryTorSocksProxy = null;
    p2pQueueManager?.updateProxyUrl(null);
    runtimeShutdownComplete = true;
  })();

  return shutdownInProgress;
};

const pruneComponentVersions = async (
  userDataDir: string,
  network: OnionNetwork,
  keep: { version: string; installPath: string }
) => {
  const componentsRoot = path.join(userDataDir, "onion", "components", network);
  const normalizedRoot = path.resolve(componentsRoot) + path.sep;
  const normalizedKeep = path.resolve(keep.installPath);

  if (!normalizedKeep.startsWith(normalizedRoot)) return;

  try {
    const entries = await fs.readdir(componentsRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          if (entry.name === keep.version) return;
          await removeWithRetry(path.join(componentsRoot, entry.name));
        })
    );
  } catch {
    // Best-effort cleanup; ignore.
  }
};

const formatProgress = (receivedBytes?: number, totalBytes?: number) => {
  if (!receivedBytes && !totalBytes) return "";
  const total = totalBytes ?? 0;

  if (total > 0) {
    return `${Math.round((receivedBytes ?? 0) / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB`;
  }

  return `${Math.round((receivedBytes ?? 0) / 1024 / 1024)} MB`;
};

const normalizeOnionError = (
  error: unknown,
  context: Record<string, unknown>
) => {
  const message = error instanceof Error ? error.message : String(error);

  const errCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code ?? "")
      : "";

  const code =
    error instanceof PinnedHashMissingError
      ? "PINNED_HASH_MISSING"
      : errCode === "ASSET_NOT_FOUND" || message.includes("ASSET_NOT_FOUND")
        ? "ASSET_NOT_FOUND"
      : message.includes("SHA256 mismatch")
        ? "HASH_MISMATCH"
        : message.includes("Download failed") ||
            message.includes("Too many redirects") ||
            message.includes("Redirect")
          ? "DOWNLOAD_FAILED"
          : message.includes("Unsupported archive format") ||
              message.includes("tar") ||
              message.includes("unzip") ||
              message.includes("Expand-Archive")
            ? "EXTRACT_FAILED"
            : message.includes("BINARY_MISSING")
              ? "BINARY_MISSING"
              : (() => {
                  const err = error as { code?: string };

                  if (errCode === "EACCES" || errCode === "EPERM") return "PERMISSION_DENIED";

                  if (err?.code === "EACCES" || err?.code === "EPERM") return "PERMISSION_DENIED";

                  if (err?.code === "ENOENT") return "FS_ERROR";

                  return "UNKNOWN_ERROR";
                })();

  const details = (() => {
    if (!(error && typeof error === "object" && "details" in error)) {
      return context;
    }

    const rawDetails = error.details;

    if (rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)) {
      return { ...context, ...rawDetails };
    }

    if (typeof rawDetails === "string") {
      return { ...context, reason: rawDetails };
    }

    return context;
  })();

  return { code, message, details };
};

const refreshComponentState = async (userDataDir: string, network: OnionNetwork) => {
  const pointer = await readCurrentPointer(userDataDir, network);
  const componentsRoot = path.resolve(userDataDir, "onion", "components", network);
  const installPath = pointer ? path.resolve(pointer.path) : "";

  const installed = Boolean(
    pointer &&
    (installPath === componentsRoot || installPath.startsWith(`${componentsRoot}${path.sep}`)) &&
    fsSync.existsSync(path.join(installPath, getBinaryPath(network)))
  );

  return {
    ...onionComponentCache[network],
    installed,
    version: installed ? pointer?.version : undefined,
  };
};

const emitOnionProgress = (
  event: Electron.IpcMainInvokeEvent,
  network: OnionNetwork,
  status: OnionComponentState
) => {
  event.sender.send("onion:progress", { network, status });
};

const stopNetworkRuntimeForMutation = async () => {
  await onionRuntime.stop();
  await torManager?.stop();
  await torSecondaryManager?.stop();
  currentTorSocksProxy = null;
  p2pQueueManager?.updateProxyUrl(null);
  await onionController?.setTorSocksProxy(null);
  emitOnionRuntimeBackgroundStatus();
};

const registerOnionIpc = () => {
  ipcMain.handle("onion:status", async (event) => {
    assertTrustedIpcSender(event);
    const userDataDir = app.getPath("userData");

    return {
      components: {
        tor: await refreshComponentState(userDataDir, "tor"),
      },
      runtime: getUnifiedOnionRuntimeStatus(),
    } satisfies OnionStatusPayload;
  });

  ipcMain.handle("onion:checkUpdates", async (event) => {
    assertTrustedIpcSender(event);
    const userDataDir = app.getPath("userData");
    const torUpdate = await checkUpdates("tor");
    console.log("[onion] checkUpdates", {
      tor: {
        version: torUpdate.version,
        assetName: torUpdate.assetName,
        downloadUrl: torUpdate.downloadUrl,
        sha256: torUpdate.sha256 ? "<present>" : "<missing>",
        errorCode: torUpdate.errorCode,
      },
    });
    const torState = await refreshComponentState(userDataDir, "tor");

    const torHasVerifiedUpdate =
      Boolean(torUpdate.version && torUpdate.sha256 && torUpdate.downloadUrl);

    onionComponentCache.tor = {
      ...torState,
      latest: torHasVerifiedUpdate ? torUpdate.version ?? undefined : undefined,
      error:
        torUpdate.errorCode === "PINNED_HASH_MISSING"
          ? "PINNED_HASH_MISSING"
          : torUpdate.errorCode === "ASSET_NOT_FOUND"
            ? "ASSET_NOT_FOUND"
            : undefined,
      detail:
        torUpdate.errorCode === "PINNED_HASH_MISSING"
          ? torUpdate.errorReason ?? `Pinned hash missing for ${torUpdate.assetName ?? torUpdate.version ?? "unknown"}`
          : torUpdate.errorCode === "ASSET_NOT_FOUND"
            ? `No compatible Tor asset for ${process.platform}/${process.arch}`
          : undefined,
    };

    return {
      components: {
        tor: onionComponentCache.tor,
      },
      runtime: getUnifiedOnionRuntimeStatus(),
    } satisfies OnionStatusPayload;
  });

  ipcMain.handle("onion:install", (event, payload: { network: OnionNetwork }) => {
    assertTrustedIpcSender(event);
    const userDataDir = app.getPath("userData");
    const network = requireOnionNetwork(payload?.network);

    return runInstallSingleFlight(network, async () => {
      const installedState = await refreshComponentState(userDataDir, network);

      if (installedState.installed) {
        await installTor(userDataDir, installedState.version!);
        onionComponentCache[network] = installedState;
        emitOnionProgress(event, network, installedState);
        console.log("[onion] reusing shared Tor installation", {
          network,
          version: installedState.version,
        });

        return;
      }

      let updates: Awaited<ReturnType<typeof checkUpdates>> | null = null;

      try {
      updates = await checkUpdates(network);

      if (updates.errorCode === "PINNED_HASH_MISSING") {
        throw new PinnedHashMissingError(
          updates.errorReason ?? `Missing pinned hash for ${network} ${updates.assetName ?? updates.version ?? "unknown"}`
        );
      }

      if (updates.errorCode === "ASSET_NOT_FOUND") {
        throw Object.assign(new Error("ASSET_NOT_FOUND: No compatible release asset"), { code: "ASSET_NOT_FOUND", details: {
          network,
          platform: process.platform,
          arch: process.arch,
          update: updates,
        } });
      }

      if (!updates.version || !updates.sha256 || !updates.downloadUrl || !updates.assetName) {
        throw Object.assign(new Error("No verified release available"), { details: {
          network,
          platform: process.platform,
          arch: process.arch,
          update: updates,
        } });
      }

      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "downloading",
        error: undefined,
        detail: "Preparing download",
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      await stopNetworkRuntimeForMutation();

      const install = installTor(
              userDataDir,
              updates.version,
              (progress) => {
                onionComponentCache[network] = {
                  ...onionComponentCache[network],
                  status: progress.step === "download" ? "downloading" : "installing",
                  detail:
                    (progress.message ?? "") +
                    (progress.receivedBytes || progress.totalBytes
                      ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                      : ""),
                  progress:
                    progress.receivedBytes || progress.totalBytes
                      ? {
                          receivedBytes: progress.receivedBytes ?? 0,
                          totalBytes: progress.totalBytes ?? 0,
                        }
                      : undefined,
                };
                emitOnionProgress(event, network, onionComponentCache[network]);
              },
              updates.downloadUrl ?? undefined,
              updates.assetName ?? undefined
            );

      const result = await install;
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        installed: true,
        status: "ready",
        version: result.version,
        error: undefined,
        detail: `Installed ${result.version}`,
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      await pruneComponentVersions(userDataDir, network, {
        version: result.version,
        installPath: result.installPath,
      });
      } catch (error) {
      const context = {
        network,
        version: updates?.version,
        assetName: updates?.assetName,
        downloadUrl: updates?.downloadUrl,
        targetDir:
          updates?.version
            ? path.join(userDataDir, "onion", "components", network, updates.version)
            : undefined,
      };

      const normalized = normalizeOnionError(error, context);
      console.error("Onion install failed", {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });
      onionComponentCache[network] = {
        ...onionComponentCache[network],
        status: "failed",
        error: `[${normalized.code}] ${normalized.message}`,
        detail: JSON.stringify(normalized.details),
        progress: undefined,
      };
      emitOnionProgress(event, network, onionComponentCache[network]);
      throw Object.assign(new Error(`[${normalized.code}] ${normalized.message}`), { code: normalized.code, details: normalized.details });
      }
    });
  });

  ipcMain.handle("onion:applyUpdate", async (event, payload: { network: OnionNetwork }) => {
    assertTrustedIpcSender(event);
    const network = requireOnionNetwork(payload?.network);
    return runInstallSingleFlight(network, async () => {
      const userDataDir = app.getPath("userData");
      const state = await refreshComponentState(userDataDir, network);

      if (!state.installed || !state.version) {
        throw new Error("No update available");
      }

      const updateInfo = await checkUpdates(network);

      if (updateInfo.errorCode === "PINNED_HASH_MISSING") {
        throw new PinnedHashMissingError(
          updateInfo.errorReason ?? `Missing pinned hash for ${network} ${updateInfo.assetName ?? updateInfo.version ?? "unknown"}`
        );
      }

      if (updateInfo.errorCode === "ASSET_NOT_FOUND") {
        throw Object.assign(new Error("ASSET_NOT_FOUND: No compatible release asset"), { code: "ASSET_NOT_FOUND", details: {
          network,
          platform: process.platform,
          arch: process.arch,
          update: updateInfo,
        } });
      }

      if (!updateInfo.version || !updateInfo.sha256 || !updateInfo.downloadUrl || !updateInfo.assetName) {
        throw new Error("No verified release available");
      }

      const updateVersion = updateInfo.version;

      try {
        const runtimeBeforeMutation = onionRuntime.getStatus();
        const restartPrimary = torManager?.getStatus().state === "running";
        const restartSecondary = torSecondaryManager?.getStatus().state === "running";
        const shouldRestartRuntime =
          restartPrimary || restartSecondary ||
          (runtimeBeforeMutation.status === "running" && runtimeBeforeMutation.network === network);

        const result = await activateUpdate({
          currentVersion: state.version,
          nextVersion: updateVersion,
          stop: stopNetworkRuntimeForMutation,
          restart: shouldRestartRuntime,
          invalidatePath: () => {
            torManager?.invalidateResolvedPath();
            torSecondaryManager?.invalidateResolvedPath();
          },
          start: async () => {
            if (restartPrimary) await torManager!.start();
            else if (runtimeBeforeMutation.status === "running") await onionRuntime.start(userDataDir, network);
            if (restartSecondary) await torSecondaryManager!.start();
            emitOnionRuntimeBackgroundStatus();
          },
          install: () => installTor(
                userDataDir,
                updateVersion,
                (progress) => {
                  onionComponentCache[network] = {
                    ...onionComponentCache[network],
                    status: progress.step === "download" ? "downloading" : "installing",
                    detail:
                      (progress.message ?? "") +
                      (progress.receivedBytes || progress.totalBytes
                        ? ` (${formatProgress(progress.receivedBytes, progress.totalBytes)})`
                        : ""),
                    progress:
                      progress.receivedBytes || progress.totalBytes
                        ? {
                            receivedBytes: progress.receivedBytes ?? 0,
                            totalBytes: progress.totalBytes ?? 0,
                          }
                        : undefined,
                  };
                  emitOnionProgress(event, network, onionComponentCache[network]);
                },
                updateInfo.downloadUrl ?? undefined,
                updateInfo.assetName ?? undefined
              ),
        });

        onionComponentCache[network] = {
          ...onionComponentCache[network],
          installed: true,
          status: "ready",
          version: result.version,
          error: undefined,
          detail: `Installed ${result.version}`,
          progress: undefined,
        };
        emitOnionProgress(event, network, onionComponentCache[network]);
        await pruneComponentVersions(userDataDir, network, {
          version: result.version,
          installPath: result.installPath,
        });
      } catch (error) {
        const context = {
          network,
          version: updateVersion,
          assetName: updateInfo.assetName,
          downloadUrl: updateInfo.downloadUrl,
          targetDir: path.join(userDataDir, "onion", "components", network, updateVersion),
        };

        const normalized = normalizeOnionError(error, context);
        console.error("Onion update failed", {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        });
        onionComponentCache[network] = {
          ...onionComponentCache[network],
          status: "failed",
          error: `[${normalized.code}] ${normalized.message}`,
          detail: JSON.stringify(normalized.details),
          progress: undefined,
        };
        emitOnionProgress(event, network, onionComponentCache[network]);
        throw Object.assign(new Error(`[${normalized.code}] ${normalized.message}`), { code: normalized.code, details: normalized.details });
      }
    }, "update");
  });

  ipcMain.handle("onion:uninstall", async (event, payload: { network: OnionNetwork }) => {
    assertTrustedIpcSender(event);
    const network = requireOnionNetwork(payload?.network);
    return runInstallSingleFlight(network, async () => {
      await stopNetworkRuntimeForMutation();
      const userDataDir = app.getPath("userData");

      if (network === "tor") {
        await removeTorInstallationArtifacts(userDataDir);
        torManager?.invalidateResolvedPath();
        torSecondaryManager?.invalidateResolvedPath();
      } else {
        const componentRoot = path.join(userDataDir, "onion", "components", network);
        await removeWithRetry(componentRoot);
      }

      onionComponentCache[network] = { installed: false, status: "idle" };
    }, "uninstall");
  });

  ipcMain.handle(
    "onion:setMode",
    async (
      event,
      payload: {
        enabled: boolean;
        network: OnionNetwork;
        bridgeMode?: "off" | "auto" | "force";
      }
    ) => {
      assertTrustedIpcSender(event);
      requireOnionNetwork(payload?.network);

      if (!payload.enabled) {
        await Promise.all([
          onionRuntime.stop(),
          torManager?.stop(),
          torSecondaryManager?.stop(),
        ]);
        emitOnionRuntimeBackgroundStatus();

        return;
      }

      if (phase2qPreflight && phase2qPreflight.status() !== "verified") throw new Error("PREFLIGHT_REQUIRED");
      const end = cold.begin("tor.set_mode_start.begin", { lane: "primary" });

      try {
        await waitForOnionBackend();
        await onionRuntime.stop();
        await torManager!.start({ bridgeMode: payload.bridgeMode });
      } finally {
        end("tor.set_mode_start.end", torManager?.getStatus().state === "running" ? "ok" : "failed");
      }

      if (torManager?.getStatus().state === "running") {
        void ensurePrimaryHiddenService().catch((error) => {
          console.warn("[tor] hidden service preparation failed", error);
        });
      }

      emitOnionRuntimeBackgroundStatus();
    }
  );
};

const sendToAllWindows = (channel: string, payload: unknown) => {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  });
};

const emitRuntimeBackgroundStatus = (payload: BackgroundStatusPayload) => {
  lastBackgroundStatus = payload;
  sendToAllWindows("background:status", payload);
  updateTrayMenu();
};

const emitOnionRuntimeBackgroundStatus = () => {
  const runtime = getUnifiedOnionRuntimeStatus();

  if (runtime.status === "running") {
    emitRuntimeBackgroundStatus({
      state: "connected",
      route: "Tor Network",
    });

    return;
  }

  emitRuntimeBackgroundStatus({
    state: "disconnected",
    route:
      runtime.status === "starting"
        ? "Onion starting"
        : runtime.status === "failed"
          ? "Onion failed"
          : "Onion offline",
  });
};

type PendingSyncRun = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const pendingSyncRuns = new Map<string, PendingSyncRun>();

const SYNC_RUN_TIMEOUT_MS = 30_000;

let syncRunCounter = 0;

const requestRendererSyncRun = async (
  reason: SyncRunPayload["reason"]
): Promise<void> => {
  const candidates = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed()
  );

  if (!candidates.length) {
    throw new Error("sync-runner-unavailable");
  }

  const target = candidates[0];
  const requestId = `sync-${Date.now()}-${syncRunCounter++}`;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingSyncRuns.delete(requestId);
      reject(new Error("sync-timeout"));
    }, SYNC_RUN_TIMEOUT_MS);

    pendingSyncRuns.set(requestId, { resolve, reject, timeout });
    target.webContents.send("sync:run", {
      requestId,
      reason,
    } satisfies SyncRunPayload);
  });
};

class BackgroundService {
  private prefs: AppPreferences = defaultAppPrefs;
  private intervalId: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  private lastSyncAt: number | null = null;
  private lastActivityAt: number | null = null;
  private syncStatus: SyncStatusPayload = { state: "ok", lastSyncAt: null };
  private backgroundStatus: BackgroundStatusPayload = { state: "disconnected", route: "" };

  applyPrefs(prefs: AppPreferences) {
    this.prefs = prefs;

    if (!prefs.background.enabled) {
      this.stopTimers();
      this.backgroundStatus = { state: "disconnected", route: "off" };
      this.emitBackgroundStatus();

      return;
    }

    this.backgroundStatus = { state: "connected", route: "standard" };
    this.emitBackgroundStatus();
    this.scheduleInterval();
  }

  manualSync() {
    return this.runSync("manual");
  }

  emitCurrentStatus() {
    this.emitBackgroundStatus();
    this.emitSyncStatus();
  }

  private stopTimers() {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private scheduleInterval() {
    this.stopTimers();

    if (!this.prefs.background.enabled) return;

    const minutes =
      this.prefs.background.syncIntervalMinutes === 0
        ? this.computeAutoIntervalMinutes()
        : this.prefs.background.syncIntervalMinutes;

    const clamped = Math.min(30, Math.max(1, minutes));
    this.intervalId = setTimeout(() => {
      void this.runSync("interval");
    }, clamped * 60 * 1000);
  }

  private computeAutoIntervalMinutes() {
    const now = Date.now();
    const connected = this.backgroundStatus.state === "connected";

    if (this.lastActivityAt && now - this.lastActivityAt <= 5 * 60 * 1000) {
      return 3;
    }

    if (this.lastActivityAt && now - this.lastActivityAt <= 15 * 60 * 1000) {
      return 10;
    }

    return connected ? 30 : 5;
  }

  private async runSync(reason: SyncRunPayload["reason"]) {
    if (!this.prefs.background.enabled) return;

    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.syncStatus = { state: "running", lastSyncAt: this.lastSyncAt };
    this.emitSyncStatus();

    try {
      await this.performSync(reason);
      this.lastSyncAt = Date.now();
      this.lastActivityAt = this.lastSyncAt;
      this.syncStatus = { state: "ok", lastSyncAt: this.lastSyncAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.syncStatus = { state: "error", lastSyncAt: this.lastSyncAt, error: message };
    } finally {
      this.syncInFlight = false;
      this.emitSyncStatus();

      if (this.prefs.background.enabled) {
        this.scheduleInterval();
      }
    }
  }

  private async performSync(reason: SyncRunPayload["reason"]) {
    await requestRendererSyncRun(reason);
  }

  private emitSyncStatus() {
    sendToAllWindows("sync:status", this.syncStatus);
  }

  private emitBackgroundStatus() {
    sendToAllWindows("background:status", this.backgroundStatus);
    lastBackgroundStatus = this.backgroundStatus;
    updateTrayMenu();

    if (this.prefs.background.enabled) {
      this.scheduleInterval();
    }
  }
}

let mainWindow: BrowserWindow | null = null;

let tray: Tray | null = null;

let backgroundService: BackgroundService | null = null;

let isQuitting = false;

let relayToggle = false;

let currentPrefs: AppPreferences = defaultAppPrefs;

let lastBackgroundStatus: BackgroundStatusPayload = { state: "disconnected", route: "" };

const updateTrayMenu = () => {
  if (!tray) return;
  const visible = mainWindow?.isVisible() ?? false;
  const showHideLabel = visible ? "Hide" : "Show";
  const routeSuffix = lastBackgroundStatus.route ? ` (${lastBackgroundStatus.route})` : "";

  const statusLabel =
    lastBackgroundStatus.state === "connected"
      ? `Status: Connected${routeSuffix}`
      : `Status: Disconnected${routeSuffix}`;

  const menu = Menu.buildFromTemplate([
    {
      label: showHideLabel,
      click: () => {
        if (visible) {
          mainWindow?.hide();
        } else if (!focusMainWindow()) {
          createMainWindow();
        }
      },
    },
    { label: statusLabel, enabled: false },
    {
      label: "Sync now",
      click: () => {
        void backgroundService?.manualSync();
      },
    },
    {
      label: "Relay (placeholder)",
      type: "checkbox",
      checked: relayToggle,
      click: (item) => {
        relayToggle = item.checked;
        updateTrayMenu();
      },
    },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
};

const focusMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();

  return true;
};

const transparentIcon = () =>
  nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+lbkAAAAASUVORK5CYII="
  );

const getRuntimeIcon = () => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icon.png")]
    : [path.join(app.getAppPath(), "build", "icon.png"), path.join(process.cwd(), "build", "icon.png")];

  const iconPath = candidates.find((candidate) => fsSync.existsSync(candidate));

  if (!iconPath) return transparentIcon();
  const icon = nativeImage.createFromPath(iconPath);

  return icon.isEmpty() ? transparentIcon() : icon;
};

const createTray = () => {
  if (tray) return tray;
  tray = new Tray(getRuntimeIcon());
  tray.setToolTip("NKC");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else if (!focusMainWindow()) {
      createMainWindow();
    }

    updateTrayMenu();
  });
  updateTrayMenu();

  return tray;
};

const applyPrefs = async (prefs: AppPreferences) => {
  currentPrefs = prefs;

  try {
    app.setLoginItemSettings({
      openAtLogin: prefs.login.autoStartEnabled,
      args: ["--autostart"],
    });
  } catch (error) {
    console.warn("[main] failed to update login item settings", error);
  }

  backgroundService?.applyPrefs(prefs);
  updateTrayMenu();
};

const canReach = async (url: string, timeoutMs = 1200) =>
  new Promise<boolean>((resolve) => {
    try {
      const request = net.request(url);

    const timeout = setTimeout(() => {
      try {
        request.abort();
      } catch {
        // intentionally ignored
      }

      resolve(false);
    }, timeoutMs);

      request.on("response", (response) => {
        const ok = Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400);
        response.on("data", () => {});
        response.on("end", () => {
          clearTimeout(timeout);
          resolve(ok);
        });
      });
      request.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      request.end();
    } catch {
      resolve(false);
    }
  });

const isIgnorablePipeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";

  return code === "EPIPE" || message.includes("EPIPE");
};

const ignorePipeError = (error: unknown) => {
  if (isIgnorablePipeError(error)) return;
  throw error;
};

let pipeErrorHandlersInstalled = false;

const installPipeErrorHandlers = () => {
  if (pipeErrorHandlersInstalled) return;
  process.stdout?.on("error", ignorePipeError);
  process.stderr?.on("error", ignorePipeError);
  pipeErrorHandlersInstalled = true;
};

const safeLog = (...args: unknown[]) => {
  if (!process.stdout || !process.stdout.writable) return;

  try {
    console.log(...args);
  } catch (error) {
    if (isIgnorablePipeError(error)) return;
    throw error;
  }
};

export const createMainWindow = () => {
  if (focusMainWindow()) return mainWindow;
  resetPreloadToken();
  installPipeErrorHandlers();
  const preloadPath = path.join(__dirname, "preload.js");
  const preloadExists = fsSync.existsSync(preloadPath);

  if (isDev && !preloadExists) {
    console.error("[dev] preload missing at", preloadPath);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#141414",
    show: false,
    icon: getRuntimeIcon(),
    webPreferences: {
      preload: preloadExists ? preloadPath : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bindAccountSessionLifecycle(accountSessions, win.webContents);
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) resetPreloadToken();
  });
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("did-fail-load", (_event, errorCode, errorDesc, validatedURL) => {
    console.error("[main] did-fail-load", errorCode, errorDesc, validatedURL);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main] render-process-gone", details);
  });
  win.webContents.on("unresponsive", () => {
    console.error("[main] renderer unresponsive");
  });

  if (isDev) {
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (win.webContents.isDestroyed()) return;
      safeLog("[renderer]", level, message, sourceId, line);
    });
  }

  const loadRenderer = async () => {
    if (isDev && rendererUrl) {
      console.log("[dev] rendererUrl =", rendererUrl);
      const ok = await canReach(rendererUrl);

      if (ok) {
        console.log("[dev] loadURL =", rendererUrl);
        void win.loadURL(rendererUrl);

        return;
      }

      console.error("[dev] vite not reachable", rendererUrl);
    }

    if (isDev) {
      const fallbackUrl = "http://localhost:5173/";
      const ok = await canReach(fallbackUrl);

      if (ok) {
        console.log("[dev] loadURL =", fallbackUrl);
        void win.loadURL(fallbackUrl);

        return;
      }

      const distIndex = path.join(__dirname, "../dist/index.html");

      if (fsSync.existsSync(distIndex)) {
        console.log("[dev] loadFile =", distIndex);
        void win.loadFile(distIndex);

        return;
      }

      const html = `<!doctype html><html><head><meta charset="utf-8" /><title>Dev Server Unavailable</title></head><body style="font-family:sans-serif;padding:16px;"><h2>Dev server not reachable</h2><p>Start Vite on http://localhost:5173 and reload.</p></body></html>`;
      console.log("[dev] loadURL = dev fallback page");
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      return;
    }

    void win.loadURL("nkc-app://bundle/index.html");
  };

  win.webContents.once("did-finish-load", () => cold.mark("ui.renderer.loaded"));
  void loadRenderer();
  win.once("ready-to-show", () => {
    cold.mark("ui.ready_to_show");
    const shouldStartHidden = currentPrefs.login.startInTray && isAutoStartLaunch;

    if (!shouldStartHidden) {
      win.show();
    }
  });

  if (isDev && process.env.OPEN_DEV_TOOLS) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow = win;
  backgroundService?.emitCurrentStatus();
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();

    if (currentPrefs.login.closeToExit) app.quit();
    else win.hide();
  });
  win.on("show", () => updateTrayMenu());
  win.on("hide", () => updateTrayMenu());
  win.on("closed", () => {
    mainWindow = null;
    updateTrayMenu();
  });

  return win;
};

const unifiedTextExperiment = authorizeDisposableRatchetProfile({
  development: isDev, requested: process.env.NKC_TEST_UNIFIED_RATCHET === "1",
  root: process.env.NKC_E2E_USER_DATA_DIR, temporaryDirectory: app.getPath("temp"),
});

const recoveryV2Experiment = authorizeDisposableRecoveryProfile({
  requested: process.env.NKC_TEST_PHASE2Q_RECOVERY === "1", unifiedAuthorized: unifiedTextExperiment,
  root: process.env.NKC_E2E_USER_DATA_DIR, temporaryDirectory: app.getPath("temp"),
});

const nativeRatchetCasExperiment = authorizeDisposableNativeOwnerProfile({
  development: isDev, requested: process.env.NKC_TEST_PHASE10E_NATIVE_OWNER === "1",
  unifiedAuthorized: unifiedTextExperiment,
  root: process.env.NKC_E2E_USER_DATA_DIR, temporaryDirectory: app.getPath("temp"),
});

configureNativeRatchetOwner(nativeRatchetCasExperiment);

if (isDev) {
  const temp = app.getPath("temp");
  const devRoot = process.env.NKC_E2E_USER_DATA_DIR || path.join(temp, "nkc-electron-dev");
  const devUserData = path.join(devRoot, "userData");
  const devCache = path.join(devRoot, "cache");
  const devSession = path.join(devRoot, "sessionData");
  const devTemp = path.join(devRoot, "temp");
  fsSync.mkdirSync(devRoot, { recursive: true });
  fsSync.mkdirSync(devUserData, { recursive: true });
  fsSync.mkdirSync(devCache, { recursive: true });
  fsSync.mkdirSync(devSession, { recursive: true });
  fsSync.mkdirSync(devTemp, { recursive: true });
  app.setPath("userData", devUserData);
  app.setPath("sessionData", devSession);
  app.setPath("temp", devTemp);
  console.log("[dev] userData =", app.getPath("userData"), "temp =", app.getPath("temp"));
}

const phase2qPreflight = recoveryV2Experiment ? createPhase2QPreflight(app.getPath("userData"), safeStorage) : null;

if (phase2qPreflight) app.on("quit", () => {
  try { phase2qPreflight.markCleanExit(); }
  catch { console.warn("[phase2q] preflight clean-exit marker failed"); }
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
} else {
  app.on("second-instance", () => {
    if (!focusMainWindow()) createMainWindow();
  });
}

app.whenReady().then(async () => {
  cold.configure(app.getPath("userData"));
  cold.mark("app.when_ready");

  if (process.platform === "win32") {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");
      safeStorage.encryptString("NKC storage readiness");
      await waitForStorageKeyPersistence(app.getPath("sessionData"));
    } catch {
      dialog.showErrorBox("NKC storage unavailable", "NKC could not verify protected local storage. No account was created. Restart NKC and try again.");
      app.quit();
      return;
    }
  }

  if (isDev) {
    console.log("[main] VITE_DEV_SERVER_URL =", process.env.VITE_DEV_SERVER_URL ?? "");
  }

  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  const rendererRoot = path.resolve(__dirname, "../dist");
  protocol.handle("nkc-app", (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.host !== "bundle") return new Response("Not found", { status: 404 });
    let relativePath: string;

    try {
      relativePath = decodeURIComponent(requestUrl.pathname).replace(/^[/\\]+/, "");
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const candidate = path.resolve(rendererRoot, relativePath);

    if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(candidate).toString());
  });
  await loadApprovedFetchOrigins();
  backgroundService = new BackgroundService();
  initializeOnionManagers();
  registerProxyIpc();
  registerOnionFetchIpc();
  registerSecretStoreIpc(assertTrustedIpcSender, phase2qPreflight ? () => {
    if (phase2qPreflight.status() !== "verified") throw new Error("PREFLIGHT_REQUIRED");
  } : undefined, nativeRatchetCasExperiment, accountSessions, async (session, assertCurrent) => {
    await p2pQueueManager?.setActiveAccount(session.accountId, assertCurrent, session.token);
  });
  const hintDirectory = unifiedTextExperiment ? path.dirname(app.getPath("userData")) + "-rollback-hints"
    : path.join(process.env.LOCALAPPDATA ?? app.getPath("appData"), "NKC", "security-hints-v1");
  const rollbackHints = new RollbackHintStore(hintDirectory, text => safeStorage.encryptString(text), bytes => safeStorage.decryptString(bytes));
  ipcMain.handle("freshness:localHint", async (event, session: MainAccountSession, root: string, certificates) => {
    assertTrustedIpcSender(event);
    const assertOwner = () => { accountSessions.assertCurrent(event.sender.id, session); };
    assertOwner();
    if (process.platform !== "win32" || !safeStorage.isEncryptionAvailable()) return "UNAVAILABLE";
    const result = await rollbackHints.compare(root, certificates, assertOwner);
    assertOwner();
    return result;
  });

  if (phase2qPreflight) {
    ipcMain.handle("phase2q:preflightStatus", (event) => {
      assertTrustedIpcSender(event);

      return phase2qPreflight.status();
    });
    ipcMain.handle("phase2q:preflightPrepare", (event) => {
      assertTrustedIpcSender(event);

      return phase2qPreflight.prepare();
    });
  }

  registerPermanentMediaIpc(assertTrustedIpcSender, accountSessions);
  registerOnionIpc();
  registerOnionControllerIpc();
  registerP2PQueueIpc({
    sessions: accountSessions,
    assertTrustedIpcSender,
    getQueueManager: () => p2pQueueManager,
    getNativeWorkerClient: () => nativeWorkerClient,
    experimentalUnifiedText: unifiedTextExperiment,
  });
  registerCapabilityIpc(isTrustedIpcSender, { unifiedText: unifiedTextExperiment,
    recoveryV2: recoveryV2Experiment, nativeRatchetCas: nativeRatchetCasExperiment });
  registerNativeWorkerIpc({
    assertTrustedIpcSender,
    isTrustedIpcSender,
    getNativeWorkerClient: () => nativeWorkerClient,
  });
  registerAppIpc();
  registerAppUpdaterIpc(assertTrustedIpcSender);

  registerTestLogIpc(assertTrustedIpcSender);
  void ensureOnionBackend().catch((error) => {
    console.error("[main] onion backend initialization failed; next request can retry", error);
  });
  const prefs = await readAppPrefs();
  await applyPrefs(prefs);
  createTray();
  cold.mark("ui.create.begin");
  createMainWindow();
  cold.mark("ui.create.returned");
  scheduleInitialAppUpdateCheck();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", (event) => {
  isQuitting = true;

  if (!runtimeShutdownComplete) {
    event.preventDefault();
    void shutdownBackgroundRuntimes()
      .catch((error) => {
        console.error("[main] runtime shutdown failed", error);
      })
      .finally(() => {
        app.quit();
      });

    return;
  }

  console.log("[main] before-quit");
});

app.on("will-quit", () => {
  void shutdownBackgroundRuntimes().catch((error) => {
    console.error("[main] runtime shutdown failed during will-quit", error);
  });
  console.log("[main] will-quit");
});

app.on("quit", (_event, code) => console.log("[main] quit", code));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
