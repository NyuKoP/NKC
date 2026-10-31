import { legacyOutboxCiphertext } from "../storage/storedPayload";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "../appRouter";
import { useAppStore } from "./store";
import { cancelInvalidatedOutgoing } from "../policies/deliveryPolicy";
import Onboarding from "../components/Onboarding";
import Unlock, { type UnlockResult } from "../components/Unlock";
import StartKey from "../components/StartKey";
import FriendAddDialog from "../components/FriendAddDialog";
import GroupCreateDialog from "../components/GroupCreateDialog";
import GroupInviteDialog from "../components/GroupInviteDialog";
import Sidebar from "../components/Sidebar";
import ProfileEditorDialog from "../components/ProfileEditorDialog";
import ChatView from "../components/ChatView";
import { recoverPermanentMediaDecryption } from "../media/permanentDecryption";
import RightPanel from "../components/RightPanel";
import ConfirmDialog from "../components/ConfirmDialog";
import Toasts from "../components/Toasts";
import { createId } from "../utils/ids";
import {
  activateAccount,
  createLocalAccount,
  findMatchingLocalAccount,
  getActiveAccount,
  getActiveAccountId,
  removeLocalAccount,
  renameActiveAccount,
} from "../accounts/accountRegistry";
import { acquireMainAccountSession, getAccountOwnerGeneration } from "../accounts/accountOwnerLifecycle";
import { removeAccountLocalStorage, removeAccountSecrets } from "../accounts/accountDeletion";
import { deleteVaultDatabase, switchVaultDb } from "../db/schema";
import {
  bootstrapVault,
  resetVaultStorage,
  getVaultHeader,
  listConversations,
  listProfiles,
  lockVault,
  repairVaultTextEncoding,
  verifyStartKeyForCurrentVault,
  verifyVaultKeyId,
  rotateVaultKeys,
  deleteConversationData,
  deleteMessagesById,
  saveConversation,
  completePendingFriendResponse,
  applyLocalFriendResponse,
  savePendingFriendRequest,
  saveMessage,
  getStoredMessage,
  createMessageMediaRef,
  saveMessageMedia,
  readMessageMediaChunks,
  saveProfile,
  saveProfileWithPhoto,
  loadProfilePhoto,
  saveGroupPhotoRef,
  loadAvatarFromRef,
  unlockVault,
  wipeVault,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { chunkBuffer, encryptJsonRecord, validateStartKey } from "../crypto/vault";
import { getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import {
  computeFriendId,
  decodeFriendCodeV1,
  encodeFriendCodeV1,
  type FriendCodeV1,
} from "../security/friendCode";
import { canonicalInviteCodeV1, decodeInviteCodeV1 } from "../security/inviteCode";
import { runOneTimeInviteGuard } from "../security/inviteUseStore";
import { checkAllowed, recordFail, recordSuccess } from "../security/rateLimit";
import { applyTOFU, hasAuthenticatedFriendKeys } from "../security/trust";
import { sha256 } from "../security/sha256";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { inspectOutgoingMediaFile } from "../security/mediaPolicy";
import { storeStartKey } from "../security/startKey";
import { clearPin, clearPinRecord, getPinStatus, isPinUnavailableError, reconcilePinAfterStartKeyRotation, setPin as savePin, verifyPin, wipePinState } from "../security/pin";
import { loadConversationMessages } from "../security/messageStore";
import { clearFriendPsk, getFriendPsk, setFriendPsk } from "../security/pskStore";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import {
  getDhPrivateKey,
  getDhPublicKey,
  getIdentityPrivateKey,
  getIdentityPublicKey,
  getOrCreateDhKeypair,
  getOrCreateIdentityKeypair,
} from "../security/identityKeys";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { deriveConversationKeyPair, encryptEnvelope } from "../crypto/box";
import { EnvelopeCryptoPool } from "../crypto/envelopeCryptoPool";
import { getSodium } from "../security/sodium";
import { unifiedAppExperimentEnabled } from "../sync/unifiedAppPolicy";
import { sendUnifiedAppText, recoverUnifiedAppPending } from "../sync/unifiedAppRatchet";
import { onAuthenticatedSyncTextStored, usesCertifiedDelivery, sendOwnedDirectEnvelope, sendAccountMessage, sendAccountRead, sendAccountMediaChunk, sendAccountProfile, type DirectEnvelopeOptions } from "../sync/syncEngine";
import { getAccountRootIdentity, getAuthorizedDeviceRegistry } from "../devices/deviceApprovals";
import { deviceDeliveryIdentity } from "../sync/receivedText";
import { canonicalBytes } from "../crypto/canonicalJson";
import { captureLocalOperationContext, type ReceiveContext } from "../accounts/receiveContext";
import { parseAvatarRef } from "../utils/avatarRefs";
import { prewarmRouter, resetRouterRuntime, sendCiphertext } from "../net/router";
import { startOutboxScheduler, stopOutboxScheduler } from "../net/outboxScheduler";
import { clearOutboxQueue, deleteOutbox, listOutboxByConv } from "../storage/outboxStore";
import { getConnectionStatus, onConnectionStatus } from "../net/connectionStatus";
import { restoreTorRouter } from "../net/tor/restoreTorRouter";
import { useNetConfigStore } from "../net/netConfigStore";
import { shouldAutoPrepareTor } from "../net/netConfig";
import { firstMessageMeasurement, measureStartupStep } from "../diagnostics/coldStartMetrics";
import { getOnionStatus } from "../net/onionControl";
import {
  runVerifiedTorAutoUpdate,
  TOR_AUTO_UPDATE_INTERVAL_MS,
} from "../net/torAutoUpdate";
import { TorRuntime } from "../net/tor/TorRuntime";
import {
  selectTorRuntimeCandidate,
  type TorRuntimeCandidate,
} from "../net/tor/runtimeCandidate";
import {
  ensureLocalOnionEndpoint,
  ensurePublishedLocalOnionEndpoint,
} from "../net/tor/localOnionEndpoint";
import { sanitizeRoutingHints } from "../net/privacy";
import {
  buildGroupInviteEvent,
  buildGroupLeaveEvent,
  syncGroupCreate,
  encodeGroupEvent,
  type GroupEventPayload,
} from "../sync/groupSync";
import {
  connectConversation as connectSyncConversation,
  disconnectConversation as disconnectSyncConversation,
  syncContactsNow,
  syncConversation,
  syncConversationsNow,
  canUseBinaryMediaTransport,
} from "../sync/syncEngine";
import {
  getTransportStatus,
  onTransportStatusChange,
  setDirectApprovalHandler,
  type ConversationTransportStatus,
} from "../net/transportManager";
import { putReadCursor } from "../storage/receiptStore";
import {
  getConvAllowDirect,
  getPrivacyPrefs,
  PRIVACY_PREFS_CHANGED_EVENT,
  setGroupAvatarOverride,
} from "../security/preferences";
import { setFriendAlias } from "../storage/friendStore";
import { resolveDisplayName, resolveFriendDisplayName } from "../utils/displayName";
import { startFriendRequestScheduler } from "../friends/friendRequestScheduler";
import { isTorFriendCodeReady } from "../friends/friendCodeReadiness";
import {
  startFriendResponseScheduler,
  type PendingFriendResponseType,
} from "../friends/friendResponseScheduler";
import { startFriendInboxListener } from "../friends/friendInbox";
import {
  enrichFriendControlFrameWithProtocol,
  getSerializedProfileUpdateKind,
  isFriendControlFrame,
  signFriendControlFrame,
  stripFriendControlFrameSignature,
  type FriendControlFrame,
} from "../friends/friendControlFrame";
import {
  attachInfoCollectionLogSink,
  emitFriendAddInfoLog,
  emitFriendRouteOutgoingInfoLog,
  emitFlowTraceLog,
  type FriendAddInfoLogInput,
  type FriendRouteOutgoingInfoLogInput,
  emitRouterInfoLog,
  type RouterInfoLogInput,
} from "../diagnostics/infoCollectionLogs";
import {
  classifyRouteFailure,
  collectRouteErrorCodes,
  splitRouteErrorParts,
  toInfoLogErrorDetail,
} from "../diagnostics/friendRouteLogUtils";
import { useProfileDecorations } from "./hooks/useProfileDecorations";
import { useTrustState } from "./hooks/useTrustState";
import { onBackgroundStatus, onSyncRun, reportSyncResult } from "../appControl";
import {
  createMediaTransferProgress,
  markMediaTransferStored,
  waitForMediaTransferCompletion,
} from "../storage/mediaTransferStore";
import {
  INLINE_MEDIA_CHUNK_SIZE,
  INLINE_MEDIA_MAX_BYTES,
} from "../net/mediaTransferLimits";
import { createSafeConsole } from "../diagnostics/safeConsole";
import { AdaptiveTransferWindow } from "../net/adaptiveTransferWindow";
import { createMediaTransferLanePool } from "../net/mediaTransferLanePool";
import {
  createProfilePresence,
  createSharedProfilePresence,
  PRESENCE_HEARTBEAT_MS,
  type PresenceStatus,
} from "../profile/presence";

const console = createSafeConsole(globalThis.console);

const SettingsDialog = lazy(() => import("../components/SettingsDialog"));

const buildNameMap = (
  profiles: UserProfile[],
  aliasesById: Record<string, string | undefined>
) =>
  profiles.reduce<Record<string, string>>((acc, profile) => {
    acc[profile.id] = resolveDisplayName({
      alias: aliasesById[profile.id],
      displayName: profile.displayName,
      friendId: profile.friendId,
      id: profile.id,
    });

    return acc;
  }, {});

const READ_CURSOR_THROTTLE_MS = 300;

const ROUTE_PENDING_TOAST_COOLDOWN_MS = 10_000;

const FRIEND_ROUTE_SEND_DEADLINE_MS = 70_000;

const SECONDARY_TOR_TRANSFER_THRESHOLD_BYTES = 10 * 1024 * 1024;

const getTorStartupTimeoutMs = (bridgeMode: "off" | "auto" | "force" | undefined) => {
  if (bridgeMode === "force") return 185_000;

  if (bridgeMode === "auto") return 250_000;

  return 65_000;
};

const encodeProfileAvatar = async (profile: UserProfile, context?: ReceiveContext) => {
  const source = await loadProfilePhoto(profile.avatarRef, context?.vault);

  if (!source) return undefined;
  let prepared = source;

  if (source.type === "image/jpeg" || source.type === "image/png") {
    const bitmap = await createImageBitmap(source);

    try {
      const maxSide = 256;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");

      if (context) {
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        prepared =
          (await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/webp", 0.82)
          )) ?? source;
      }
    } finally {
      bitmap.close();
    }
  }

  return {
    mime: prepared.type,
    data: encodeBase64Url(new Uint8Array(await prepared.arrayBuffer())),
  };
};

const newClientBatchId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  }

  return encodeBase64Url(bytes);
};

const nowMonotonicMs = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
};

const waitMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type RuntimeNetworkSnapshot = {
  torState: string | null;
  torDetail: string | null;
  hiddenServiceState: "idle" | "preparing" | "ready" | "failed" | null;
};

type RuntimeBootstrapDiagnostics = {
  torRuntimeState?: ReturnType<TorRuntime["getState"]>;
  torDataDir?: ReturnType<TorRuntime["getDataDir"]>;
  torSocksPort?: string | null;
  torRuntimeError?: string;
  torStartError?: string;
  hiddenServiceError?: string;
};

const EMPTY_RUNTIME_NETWORK_SNAPSHOT: RuntimeNetworkSnapshot = {
  torState: null,
  torDetail: null,
  hiddenServiceState: null,
};

const toRuntimeState = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const state = "state" in value ? value.state : undefined;

  return typeof state === "string" && state.trim().length > 0 ? state : null;
};

const toRuntimeDetail = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const details = "details" in value ? value.details : undefined;
  const fallback = "error" in value ? value.error : undefined;
  const source = details ?? fallback;

  return typeof source === "string" && source.trim().length > 0 ? source : null;
};

const toHiddenServiceState = (value: unknown): RuntimeNetworkSnapshot["hiddenServiceState"] => {
  if (!value || typeof value !== "object") return null;
  const state = "hiddenServiceState" in value ? value.hiddenServiceState : undefined;

  return state === "idle" || state === "preparing" || state === "ready" || state === "failed"
    ? state
    : null;
};

const sameRoutingHints = (
  lhs?: { onionAddr?: string; deviceId?: string; inboxWriteToken?: string },
  rhs?: { onionAddr?: string; deviceId?: string; inboxWriteToken?: string }
) =>
  (lhs?.deviceId ?? "") === (rhs?.deviceId ?? "") &&
  (lhs?.onionAddr ?? "") === (rhs?.onionAddr ?? "") &&
  (lhs?.inboxWriteToken ?? "") === (rhs?.inboxWriteToken ?? "");

const sameRuntimeNetworkSnapshot = (lhs: RuntimeNetworkSnapshot, rhs: RuntimeNetworkSnapshot) =>
  lhs.torState === rhs.torState &&
  lhs.torDetail === rhs.torDetail &&
  lhs.hiddenServiceState === rhs.hiddenServiceState;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    updateCallbackDone: Promise<unknown>;
  };
};

const applyDocumentTheme = (theme: "dark" | "light", animate = false, assertCurrent?: () => void): Promise<void> => {
  if (typeof document === "undefined") return Promise.resolve();

  const updateTheme = () => {
    assertCurrent?.();
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    window.localStorage.setItem("nkc.theme", theme);
  };

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const startViewTransition = (document as ViewTransitionDocument).startViewTransition;

  if (animate && !reduceMotion && typeof startViewTransition === "function") {
    const transition = startViewTransition.call(document, updateTheme);

    return transition.updateCallbackDone.then(() => undefined);
  }

  updateTheme();

  return Promise.resolve();
};

const t = (ko: string, en: string) => useAppStore.getState().ui.language === "ko" ? ko : en;

export default function App() {
  const ui = useAppStore((state) => state.ui);
  const userProfile = useAppStore((state) => state.userProfile);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const friends = useAppStore((state) => state.friends);
  const convs = useAppStore((state) => state.convs);
  const setMode = useAppStore((state) => state.setMode);
  const setSelectedConv = useAppStore((state) => state.setSelectedConv);
  const setIsComposing = useAppStore((state) => state.setIsComposing);
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const setListMode = useAppStore((state) => state.setListMode);
  const setListFilter = useAppStore((state) => state.setListFilter);
  const setSearch = useAppStore((state) => state.setSearch);
  const setSessionState = useAppStore((state) => state.setSession);
  const setUserProfile = useAppStore((state) => state.setUserProfile);
  const setFriends = useAppStore((state) => state.setFriends);
  const setData = useAppStore((state) => state.setData);
  const clearAccountView = useAppStore((state) => state.clearAccountView);
  const addToast = useAppStore((state) => state.addToast);
  const confirm = useAppStore((state) => state.ui.confirm);
  const setConfirm = useAppStore((state) => state.setConfirm);

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const accountId = getActiveAccount().id;
    if (!window.p2pQueue) return;
    void acquireMainAccountSession(accountId)
      .then(session => window.p2pQueue!.setActiveAccount(accountId, session))
      .then((result) => {
        if (!result.ok) console.warn("[account-network] failed to activate queue partition", result.error);
      })
      .catch((error) => console.warn("[account-network] failed to activate queue partition", error));
  }, []);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("nkc.theme");
    const fallbackTheme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : "dark";
    void applyDocumentTheme(userProfile?.theme ?? fallbackTheme);
  }, [userProfile?.theme]);

  const [pinEnabled, setPinEnabled] = useState(false);
  const [defaultTab, setDefaultTab] = useState<"create" | "startKey">("create");
  const [pinNeedsReset, setPinNeedsReset] = useState(false);
  const wasHiddenRef = useRef(false);

  const [onboardingError, setOnboardingError] = useState("");
  const [friendAddOpen, setFriendAddOpen] = useState(false);
  const [routeResolveBusy, setRouteResolveBusy] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupInviteOpen, setGroupInviteOpen] = useState(false);
  const [groupInviteConvId, setGroupInviteConvId] = useState<string | null>(null);
  const [myFriendCode, setMyFriendCode] = useState("");

  const [friendCodeRuntimeSnapshot, setFriendCodeRuntimeSnapshot] = useState<RuntimeNetworkSnapshot>(
    EMPTY_RUNTIME_NETWORK_SNAPSHOT
  );

  const [sidebarRuntimeSnapshot, setSidebarRuntimeSnapshot] = useState<RuntimeNetworkSnapshot>(
    EMPTY_RUNTIME_NETWORK_SNAPSHOT
  );

  const [transportStatusByConv, setTransportStatusByConv] = useState<
    Record<string, ConversationTransportStatus>
  >({});

  const netConfig = useNetConfigStore((state) => state.config);
  const friendRouteWakeSignatureRef = useRef<Record<string, string>>({});
  const friendRequestInFlightRef = useRef(new Map<string, Promise<boolean>>());
  const friendResponseInFlightRef = useRef(new Set<string>());

  const profileBroadcastRef = useRef<
    (profile: UserProfile, includeAvatar?: boolean) => Promise<void>
  >(async () => {});

  const profileBroadcastInFlightRef = useRef<Promise<void> | null>(null);

  const pendingProfileBroadcastRef = useRef<
    { profile: UserProfile; includeAvatar: boolean; accountId: string; generation: number } | null
  >(null);

  const [friendActionPendingConvId, setFriendActionPendingConvId] = useState<string | null>(null);

  const friendAddInFlightRef = useRef(
    new Map<string, Promise<{ ok: boolean; error?: string }>>()
  );

  const onionRouteRequired = netConfig.mode === "onionRouter" || netConfig.onionEnabled;

  const setFriendAddDialogOpen = useCallback((open: boolean) => {
    setMyFriendCode("");
    setFriendCodeRuntimeSnapshot(EMPTY_RUNTIME_NETWORK_SNAPSHOT);
    setFriendAddOpen(open);
  }, []);

  const {
    groupAvatarOverrides,
    friendAliasesById,
    groupAvatarRefsByConv,
    refreshGroupAvatarOverrides,
    refreshFriendAliases,
    setFriendAliasInState,
  } = useProfileDecorations({ convs });

  const onboardingLockRef = useRef(false);
  const bootGuardRef = useRef<Promise<void> | null>(null);
  const outboxSchedulerStarted = useRef(false);
  const activeSyncConvRef = useRef<string | null>(null);
  const prewarmedOnionRoutesRef = useRef<Map<string, number>>(new Map());
  const mediaTransferLanePoolRef = useRef(createMediaTransferLanePool(3));
  const sendBatchInFlightRef = useRef(new Set<string>());
  const lastReadCursorSentAtRef = useRef<Record<string, number>>({});
  const lastReadCursorSentTsRef = useRef<Record<string, number>>({});

  const pendingReadCursorRef = useRef<
    Record<string, { cursorTs: number; anchorMsgId: string } | undefined>
  >({});

  const readCursorThrottleTimerRef = useRef<Record<string, number | undefined>>({});
  const routePendingToastRef = useRef<Record<string, number>>({});
  const onionBootstrapToastAtRef = useRef(0);
  const routerBootstrapRunKeyRef = useRef<string | null>(null);

  const connectionToastShown = useRef(false);
  const connectionToastKey = "nkc.sessionConnectedToastShown";

  const isDev = Boolean(import.meta.env?.DEV);

  const devLog = useCallback(
    (message: string, detail?: Record<string, unknown>) => {
      if (!isDev) return;

      if (detail) console.debug(`[app] ${message}`, detail);
      else console.debug(`[app] ${message}`);
    },
    [isDev]
  );

  const emitFriendAddTestLog = useCallback((detail: FriendAddInfoLogInput) => {
    emitFriendAddInfoLog(detail);
  }, []);

  const emitFriendRouteTestLog = useCallback((detail: FriendRouteOutgoingInfoLogInput) => {
    emitFriendRouteOutgoingInfoLog(detail);
  }, []);

  const emitRouterTestLog = useCallback((detail: RouterInfoLogInput) => {
    emitRouterInfoLog(detail);
  }, []);

  const resolveRuntimeNetworkSnapshot = useCallback(async (): Promise<RuntimeNetworkSnapshot> => {
    let builtInCandidate: TorRuntimeCandidate | null = null;

    try {
      const onionStatus = await getOnionStatus();
      const runtime = onionStatus.runtime;
      builtInCandidate = {
        state: runtime.status,
        detail: runtime.error ?? null,
        socksUrl:
          runtime.status === "running" &&
          runtime.network === "tor" &&
          typeof runtime.socksPort === "number"
            ? `socks5://127.0.0.1:${runtime.socksPort}`
            : null,
      };
    } catch {
      // Browser-only tests and older preload surfaces may not expose the built-in Onion bridge.
    }

    const nkc = (
      globalThis as {
        nkc?: {
          getTorStatus?: () => Promise<unknown>;
          checkSocksProxyReachable?: (payload: {
            socksUrl: string;
            timeoutMs?: number;
          }) => Promise<boolean>;
        };
      }
    ).nkc;

    let legacyCandidate: TorRuntimeCandidate | null = null;
    let hiddenServiceState: RuntimeNetworkSnapshot["hiddenServiceState"] = null;

    if (nkc?.getTorStatus) {
      try {
        const torRaw = await nkc.getTorStatus();
        hiddenServiceState = toHiddenServiceState(torRaw);

        const socksProxyUrl =
          torRaw && typeof torRaw === "object"
            ? (torRaw as { socksProxyUrl?: unknown }).socksProxyUrl
            : null;

        legacyCandidate = {
          state: toRuntimeState(torRaw),
          detail: toRuntimeDetail(torRaw),
          socksUrl: typeof socksProxyUrl === "string" ? socksProxyUrl : null,
        };
      } catch {
        legacyCandidate = null;
      }
    }

    const candidate = selectTorRuntimeCandidate(builtInCandidate, legacyCandidate);
    let torState = candidate?.state ?? null;
    let torDetail = candidate?.detail ?? null;

    if (torState === "running") {
      let proxyReachable = false;

      if (candidate?.socksUrl && nkc?.checkSocksProxyReachable) {
        try {
          proxyReachable = await nkc.checkSocksProxyReachable({
            socksUrl: candidate.socksUrl,
            timeoutMs: 2_000,
          });
        } catch {
          proxyReachable = false;
        }
      }

      if (!proxyReachable) {
        torState = "starting";
        torDetail = "Tor SOCKS proxy is not reachable yet";
      }
    }

    return {
      torState,
      torDetail,
      hiddenServiceState,
    };
  }, []);

  const refreshSidebarRuntimeSnapshot = useCallback(async () => {
    const snapshot = await resolveRuntimeNetworkSnapshot();
    setSidebarRuntimeSnapshot((prev) =>
      sameRuntimeNetworkSnapshot(prev, snapshot) ? prev : snapshot
    );
  }, [resolveRuntimeNetworkSnapshot]);

  useEffect(() => {
    void refreshSidebarRuntimeSnapshot();

    const unsubscribe = onBackgroundStatus(() => {
      void refreshSidebarRuntimeSnapshot();
    });

    const timer = window.setInterval(() => {
      void refreshSidebarRuntimeSnapshot();
    }, 4_000);

    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refreshSidebarRuntimeSnapshot]);

  const sidebarNetworkStatus = useMemo(() => {
    const t = (ko: string, en: string) => ui.language === "ko" ? ko : en;
    const torState = sidebarRuntimeSnapshot.torState ?? "";

    if (torState === "running") {
      if (sidebarRuntimeSnapshot.hiddenServiceState === "preparing") {
        return { state: "connected" as const, label: t("Tor 연결됨 · 수신 경로 준비 중", "Tor connected · preparing incoming route") };
      }

      if (sidebarRuntimeSnapshot.hiddenServiceState === "failed") {
        return { state: "connected" as const, label: t("Tor 연결됨 · 수신 경로 확인 필요", "Tor connected · check incoming route") };
      }

      return { state: "connected" as const, label: t("Tor 연결됨", "Tor connected") };
    }

    if (torState === "starting") {
      return { state: "connecting" as const, label: t("연결 중", "Connecting") };
    }

    if (torState === "error") {
      return { state: "error" as const, label: t("오류", "Error") };
    }

    return { state: "disconnected" as const, label: t("연결 안됨", "Disconnected") };
  }, [sidebarRuntimeSnapshot, ui.language]);

  useEffect(() => {
    return attachInfoCollectionLogSink();
  }, []);

  const settingsOpen = location.pathname === "/settings";

  const getRoutePendingToast = useCallback((error?: string) => {
    if (error?.includes("FRIEND_AUTHENTICATION_REQUIRED")) return {
      key: "friend-authentication-required",
      text: t("친구 승인과 키 확인이 필요합니다. 최신 친구 코드를 다시 추가해 인증하세요. 메시지는 이 기기에 보관됩니다.", "Friend approval and key authentication are required. Re-add the latest friend code to authenticate. The message remains on this device."),
    };
    const errorParts = splitRouteErrorParts(error);
    const normalizedErrorParts = errorParts.length > 0 ? errorParts : error ? [error] : [];
    const errorCodes = collectRouteErrorCodes(normalizedErrorParts);
    const failureClass = classifyRouteFailure(errorCodes, normalizedErrorParts);

    if (failureClass === "missing-device-id") {
      return {
        key: "missing-device-id",
        text:
          t("상대 기기 ID가 없어 전송 경로를 만들 수 없습니다. 친구 코드를 다시 받아 업데이트하세요.", "Device information is missing. Get an updated friend code."),
      };
    }

    if (failureClass === "onion-proxy-not-ready") {
      return {
        key: "onion-proxy-not-ready",
        text:
          t("Tor 프록시가 아직 준비되지 않았습니다. Onion 적용 후 연결되면 자동 재시도됩니다.", "Tor is not ready. NKC will retry once connected."),
      };
    }

    if (failureClass === "direct-channel-not-open") {
      return {
        key: "direct-not-open",
        text:
          t("Direct P2P 연결이 아직 열리지 않았습니다. 연결 수립 후 자동 재시도됩니다.", "Legacy Direct P2P is not connected. NKC will retry after connection."),
      };
    }

    if (failureClass === "self-onion-not-ready") {
      return {
        key: "self-onion-not-ready",
        text:
          t("내부 Onion 라우트가 아직 준비되지 않았습니다. 네트워크 안정화 후 자동 재시도됩니다.", "The built-in Onion route is not ready. NKC will retry when it stabilizes."),
      };
    }

    if (failureClass === "missing-route-target") {
      return {
        key: "route-target-missing",
        text:
          t("상대의 최신 라우팅 정보(onion 주소 또는 최신 기기 ID)가 없어 전송할 수 없습니다. 상대에게 최신 친구 코드를 다시 받아주세요.", "Routing information is missing. Ask your friend for their latest code."),
      };
    }

    if (failureClass === "transport-aborted") {
      return {
        key: "transport-aborted",
        text:
          t("라우터 초기화/재시작 중으로 전송이 중단되었습니다. 잠시 후 자동 재시도됩니다.", "Delivery paused during router startup. NKC will retry shortly."),
      };
    }

    return {
      key: "generic-route-not-ready",
      text:
        t("전송 경로가 준비되지 않아 메시지가 대기열에 남았습니다. 연결 후 자동 재시도됩니다.", "Message queued while the route is unavailable. NKC will retry after connection."),
    };
  }, []);

  const notifyRoutePendingToast = useCallback(
    (convId: string, error?: string) => {
      const info = getRoutePendingToast(error);
      const now = Date.now();
      const key = `${convId}:${info.key}`;
      const lastAt = routePendingToastRef.current[key] ?? 0;

      if (now - lastAt < ROUTE_PENDING_TOAST_COOLDOWN_MS) {
        return;
      }

      routePendingToastRef.current[key] = now;
      addToast({ message: info.text });
    },
    [addToast, getRoutePendingToast]
  );

  const clearConnectionToastGuard = useCallback(() => {
    connectionToastShown.current = false;

    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(connectionToastKey);
    }
  }, [connectionToastKey]);

  const resetAppState = useCallback(() => {
    clearConnectionToastGuard();
    clearAccountView();
  }, [clearAccountView, clearConnectionToastGuard]);

  const resolveLocalRoutingHintsForFriendCode = useCallback(async (context?: ReceiveContext) => {
    context?.vault.assertLocal();
    const localDeviceId = getOrCreateDeviceId(context);

    const fallback = sanitizeRoutingHints({
      deviceId: localDeviceId,
      onionAddr: userProfile?.routingHints?.onionAddr,
      inboxWriteToken: userProfile?.routingHints?.inboxWriteToken,
    });

    const nkc = (
      globalThis as {
        nkc?: {
          ensureHiddenService?: () => Promise<unknown>;
          getMyOnionAddress?: () => Promise<string>;
          registerOnionMailbox?: (
            deviceId: string, session?: import("../accounts/mainSessionTypes").MainAccountSession
          ) => Promise<{ ok: boolean; inboxWriteToken?: string }>;
        };
      }
    ).nkc;

    if (!nkc) return fallback;

    let onionAddr: string | undefined;
    let inboxWriteToken: string | undefined;

    try {
      const mailbox = await nkc.registerOnionMailbox?.(localDeviceId,
        context?.owner.session ?? await acquireMainAccountSession(getActiveAccount().id));

      if (mailbox?.ok) inboxWriteToken = mailbox.inboxWriteToken;
    } catch {
      inboxWriteToken = undefined;
    }

    if (netConfig.onionSelectedNetwork === "tor") {
      try {
        const value = (await ensureLocalOnionEndpoint())?.trim() ?? "";

        if (value) onionAddr = value;
      } catch {
        onionAddr = undefined;
      }
    }

    await context?.vault.assertMain();
    const liveHints = sanitizeRoutingHints({
      deviceId: localDeviceId,
      onionAddr,
      inboxWriteToken,
    });

    if (liveHints) return liveHints;

    return sanitizeRoutingHints({ deviceId: localDeviceId, inboxWriteToken }) ?? fallback;
  }, [
    netConfig.onionSelectedNetwork,
    userProfile?.routingHints?.onionAddr,
    userProfile?.routingHints?.inboxWriteToken,
  ]);

  const buildLocalFriendCodePayload = useCallback(async (context?: ReceiveContext): Promise<Omit<FriendCodeV1, "v">> => {
    if (context && userProfile?.id && !(await listProfiles(context.vault)).some(profile =>
        profile.kind === "user" && profile.id === userProfile.id)) throw new Error("OWNER_PEER_MISMATCH");
    const [identityPub, dhPub, localHints] = await Promise.all([
      getIdentityPublicKey(context),
      getDhPublicKey(context),
      resolveLocalRoutingHintsForFriendCode(context),
    ]);
    await context?.vault.assertMain();

    return {
      identityPub: encodeBase64Url(identityPub),
      dhPub: encodeBase64Url(dhPub),
      deviceId: getOrCreateDeviceId(context),
      onionAddr: localHints?.onionAddr,
      inboxWriteToken: localHints?.inboxWriteToken,
    };
  }, [resolveLocalRoutingHintsForFriendCode, userProfile?.id]);

  const refreshFriendCodeRuntimeSnapshot = useCallback(async () => {
    const snapshot = await resolveRuntimeNetworkSnapshot();
    setFriendCodeRuntimeSnapshot((prev) =>
      sameRuntimeNetworkSnapshot(prev, snapshot) ? prev : snapshot
    );

    return snapshot;
  }, [resolveRuntimeNetworkSnapshot]);

  const refreshMyFriendCode = useCallback(async () => {
    if (!friendAddOpen || !userProfile) return;
    const runtimeSnapshot = await resolveRuntimeNetworkSnapshot();
    setFriendCodeRuntimeSnapshot((prev) =>
      sameRuntimeNetworkSnapshot(prev, runtimeSnapshot) ? prev : runtimeSnapshot
    );

    if (runtimeSnapshot.torState !== "running") {
      setMyFriendCode((prev) => (prev ? "" : prev));

      return;
    }

    const payload = await buildLocalFriendCodePayload();
    const verifiedRuntimeSnapshot = await resolveRuntimeNetworkSnapshot();
    setFriendCodeRuntimeSnapshot((prev) =>
      sameRuntimeNetworkSnapshot(prev, verifiedRuntimeSnapshot) ? prev : verifiedRuntimeSnapshot
    );

    if (!isTorFriendCodeReady(verifiedRuntimeSnapshot, payload)) {
      setMyFriendCode((prev) => (prev ? "" : prev));

      return;
    }

    const nextCode = encodeFriendCodeV1({
      v: 1,
      ...payload,
    });

    setMyFriendCode((prev) => (prev === nextCode ? prev : nextCode));
  }, [
    buildLocalFriendCodePayload,
    friendAddOpen,
    resolveRuntimeNetworkSnapshot,
    userProfile,
  ]);

  useEffect(() => {
    if (!friendAddOpen || !userProfile) return;
    let disposed = false;

    const refreshAll = async () => {
      const [runtimeResult, codeResult] = await Promise.allSettled([
        refreshFriendCodeRuntimeSnapshot(),
        refreshMyFriendCode(),
      ]);

      if (disposed) return;

      if (runtimeResult.status === "rejected") {
        console.error("Failed to refresh friend code runtime snapshot", runtimeResult.reason);
      }

      if (codeResult.status === "rejected") {
        console.error("Failed to refresh friend code", codeResult.reason);
      }

      if (
        runtimeResult.status === "rejected" &&
        codeResult.status === "rejected"
      ) {
        console.error("Failed to refresh friend code/runtime snapshot", {
          runtimeError: runtimeResult.reason,
          friendCodeError: codeResult.reason,
        });
      }
    };

    void refreshAll();

    const unsubscribe = onBackgroundStatus(() => {
      void refreshAll();
    });

    const timer = window.setInterval(() => {
      void refreshAll();
    }, 4_000);

    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [
    friendAddOpen,
    userProfile,
    refreshFriendCodeRuntimeSnapshot,
    refreshMyFriendCode,
    netConfig.onionEnabled,
    netConfig.onionSelectedNetwork,
    netConfig.mode,
  ]);

  const friendAddHint = useMemo(() => {
    const t = (ko: string, en: string) => ui.language === "ko" ? ko : en;

    if (!friendAddOpen) return null;

    if (!myFriendCode && friendCodeRuntimeSnapshot.torState !== "running") {
      return t("Tor 연결이 확인되면 친구 코드가 자동으로 생성됩니다.", "Your friend code is generated automatically once Tor is connected.");
    }

    if (!myFriendCode) {
      return t("Tor에 연결되었습니다. Onion 주소를 확인하는 중입니다.", "Tor connected. Checking the Onion address.");
    }

    const decoded = decodeFriendCodeV1(myFriendCode);

    if ("error" in decoded) {
      return t("친구 코드 생성이 불완전할 수 있습니다. 잠시 후 다시 복사해 주세요.", "Your friend code may be incomplete. Copy it again shortly.");
    }

    if (!isTorFriendCodeReady(friendCodeRuntimeSnapshot, decoded)) {
      return t("Tor 연결 또는 Onion 주소가 더 이상 준비되지 않았습니다.", "Tor or your Onion address is no longer ready.");
    }

    return null;
  }, [friendAddOpen, friendCodeRuntimeSnapshot, myFriendCode, ui.language]);

  useEffect(() => {
    const unsubscribe = onTransportStatusChange((convId, status) => {
      setTransportStatusByConv((prev) => ({ ...prev, [convId]: status }));
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setDirectApprovalHandler(async (convId) => {
      try {
        return await getConvAllowDirect(convId);
      } catch {
        return true;
      }
    });

    return () => {
      setDirectApprovalHandler(null);
    };
  }, []);

  const withTimeout = useCallback(
    async <T,>(promise: Promise<T>, label: string, ms = 15000) => {
      let timer: number | undefined;

      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      });

      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) window.clearTimeout(timer);
      }
    },
    []
  );

  const hydrateVault = useCallback(async () => {
    const accountId = getActiveAccountId();
    const generation = getAccountOwnerGeneration();
    const vaultKey = getVaultKey();

    const sameSession = () =>
      getActiveAccountId() === accountId &&
      getAccountOwnerGeneration() === generation &&
      getVaultKey() === vaultKey;

    const assertSession = () => {
      if (!sameSession()) throw new Error("ACCOUNT_SESSION_CHANGED_DURING_HYDRATION");
    };

    try {
      devLog("hydrate:start");
      firstMessageMeasurement.uiStage(null, "refresh_requested");

      const vk = vaultKey;

      if (vk) {
        const keyOk = await measureStartupStep("verify_key", () => withTimeout(verifyVaultKeyId(vk), "verifyVaultKeyId"));
        assertSession();

        if (!keyOk) {
          console.warn("[vault] key mismatch");
          await clearStoredSession();
          lockVault();
          resetAppState();
          setPinEnabled(false);
          setPinNeedsReset(false);
          setDefaultTab("startKey");
          setMode("onboarding");
          setOnboardingError(t("이 계정의 시작 키가 아닙니다.", "This start key does not belong to this account."));

          return;
        }
      }

      await measureStartupStep("repair_text", () => withTimeout(repairVaultTextEncoding(), "repairVaultTextEncoding"));
      assertSession();

      const profiles = await measureStartupStep("list_profiles", () => withTimeout(listProfiles(), "listProfiles"));
      assertSession();

      const legacyDemoLead = profiles.find(
        (profile) =>
          profile.kind === "friend" &&
          profile.displayName === "리드" &&
          profile.status === "업무 중" &&
          !profile.identityPub &&
          !profile.routingHints &&
          profile.verification?.status !== "verified"
      );

      if (legacyDemoLead) {
        legacyDemoLead.verification = { status: "verified", verifiedAt: Date.now() };
        assertSession();
        await withTimeout(saveProfile(legacyDemoLead), "upgradeDemoLeadTrust");
        assertSession();
      }

      const user = profiles.find((profile) => profile.kind === "user") || null;
      const friendProfiles = profiles.filter((profile) => profile.kind === "friend");

      if (!user) {
        await clearStoredSession();
        lockVault();
        resetAppState();
        setPinEnabled(false);
        setPinNeedsReset(false);
        setDefaultTab("create");
        setMode("onboarding");
        navigate("/", { replace: true });

        return;
      }

      renameActiveAccount(user.displayName);

      // Begin only after the vault/account checks. Bootstrap can overlap the
      // conversation replay; the app-mode effect reuses this same runtime start.
      const startupConfig = useNetConfigStore.getState().config;

      if (vk && shouldAutoPrepareTor(startupConfig)) {
        void TorRuntime.getInstance().start({
          timeoutMs: getTorStartupTimeoutMs(startupConfig.torBridgeMode),
          bridgeMode: startupConfig.torBridgeMode,
        }).catch(() => {
          // Network failure must not block local history. The existing app-mode
          // bootstrap/recovery path reports and retries runtime failures.
        });
      }

      const storedConversations = await withTimeout(
        measureStartupStep("restore_conversations", () => listConversations()),
        "listConversations"
      );

      assertSession();
      const conversations: Conversation[] = [];
      const messagesBy: Record<string, Message[]> = {};

      for (const storedConversation of storedConversations) {
        let conv = storedConversation;

        const isDirect =
          !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;

        const partnerId = isDirect
          ? conv.participants.find((id) => id && id !== user.id) || null
          : null;

        const partner = partnerId
          ? friendProfiles.find((profile) => profile.id === partnerId) || null
          : null;

        const shouldRepairPendingRequestBlock =
          isDirect &&
          conv.pendingAcceptance === true &&
          conv.blocked === true &&
          partner?.friendStatus === "request_in";

        const shouldRepairAcceptedRequestBlock =
          isDirect &&
          conv.friendshipAccepted === true &&
          conv.blocked === true &&
          conv.lastMessage === "친구 요청" &&
          partner?.friendStatus === "normal";

        const shouldRepairAcceptedVisibility =
          isDirect &&
          conv.friendshipAccepted === undefined &&
          conv.hidden === true &&
          conv.blocked !== true &&
          conv.pendingAcceptance !== true &&
          conv.pendingOutgoing !== true &&
          conv.lastMessage === "친구 요청이 수락되었습니다." &&
          partner?.friendStatus === "normal";

        if (shouldRepairPendingRequestBlock || shouldRepairAcceptedRequestBlock) {
          conv = {
            ...conv,
            blocked: false,
            hidden: false,
          };
          await withTimeout(
            saveConversation(conv),
            "repairPendingRequestBlock"
          );
          assertSession();
        } else if (shouldRepairAcceptedVisibility) {
          conv = {
            ...conv,
            hidden: false,
            friendshipAccepted: true,
          };
          await withTimeout(
            saveConversation(conv),
            "repairAcceptedConversationVisibility"
          );
          assertSession();
        }

        conversations.push(conv);
        messagesBy[conv.id] = await withTimeout(
          loadConversationMessages(conv, partner, user.id),
          "loadConversationMessages"
        );
        assertSession();
      }

      assertSession();
      setData({
        user,
        friends: friendProfiles,
        convs: conversations,
        messagesByConv: messagesBy,
      });

      const selected = useAppStore.getState().ui.selectedConvId;
      firstMessageMeasurement.uiStage(Object.values(messagesBy).flat().map(message => message.id), "state_updated",
        new Set(selected ? (messagesBy[selected] ?? []).map(message => message.id) : []));
      setSessionState({ unlocked: true, vkInMemory: true });
      setMode("app");

      devLog("hydrate:done", { profiles: profiles.length, convs: conversations.length });
    } catch (error) {
      if (!sameSession()) return;
      console.error("Failed to hydrate vault", error);

      await clearStoredSession();
      lockVault();
      resetAppState();

      const pinStatus = await getPinStatus();
      setPinEnabled(pinStatus.enabled);
      setPinNeedsReset(pinStatus.needsReset);

      if (pinStatus.enabled && !pinStatus.needsReset) {
        setMode("locked");
      } else {
        if (pinStatus.needsReset) {
          addToast({ message: t("PIN을 재설정해야 합니다. 시작 키로 로그인해 주세요.", "PIN must be reset. Unlock with the start key.") });
        }

        setDefaultTab("startKey");
        setMode("onboarding");
      }

      addToast({ message: t("세션이 만료되었으니 다시 로그인해 주세요.", "Your session expired. Please sign in again.") });
    }
  }, [
    addToast,
    devLog,
    navigate,
    resetAppState,
    setData,
    setDefaultTab,
    setMode,
    setPinEnabled,
    setPinNeedsReset,
    setSessionState,
    withTimeout,
  ]);

  useEffect(() => {
    if (bootGuardRef.current) return;
    let cancelled = false;

    const boot = async () => {
      try {
        const header = await getVaultHeader();

        if (!header) {
          setDefaultTab("create");
          setMode("onboarding");

          return;
        }

        const pinStatus = await getPinStatus();

        if (!cancelled) {
          setPinEnabled(pinStatus.enabled);
          setPinNeedsReset(pinStatus.needsReset);
        }

        if (pinStatus.enabled && !pinStatus.needsReset) {
          setMode("locked");
        } else {
          const session = await getStoredSession();

          if (session?.vaultKey) {
            setVaultKey(session.vaultKey);
            await setStoredSession(session.vaultKey);
            await hydrateVault();

            return;
          }

          if (pinStatus.needsReset) {
          addToast({ message: t("PIN을 재설정해야 합니다. 시작 키로 로그인해 주세요.", "PIN must be reset. Unlock with the start key.") });
          }

          setDefaultTab("startKey");
          setMode("onboarding");
        }
      } catch (error) {
        console.error("Boot failed", error);
        addToast({ message: t("초기화에 실패했습니다.", "Initialization failed. Please try again.") });
        setMode("onboarding");
      }
    };

    bootGuardRef.current = boot().finally(() => {
      bootGuardRef.current = null;
    });

    return () => {
      cancelled = true;
    };
  }, [addToast, hydrateVault, setDefaultTab, setMode, setPinEnabled, setPinNeedsReset]);

  useEffect(() => {
    if (ui.mode !== "app") return;

    if (outboxSchedulerStarted.current) return;
    startOutboxScheduler();
    outboxSchedulerStarted.current = true;

    return () => {
      stopOutboxScheduler();
      outboxSchedulerStarted.current = false;
    };
  }, [ui.mode]);

  useEffect(() => {
    if (ui.mode !== "app" || !window.nkcExperimental?.recoveryV2) return;
    let stopped = false;
    void recoverUnifiedAppPending().then((count) => {
      if (count > 0 && !stopped && getVaultKey()) return hydrateVault();
    }).catch(() => {
      // The encrypted intake remains durable. Never claim successful recovery or reset the channel.
      console.warn("[phase2q] pending receive recovery deferred");
    });

    return () => { stopped = true; };
  }, [ui.mode, hydrateVault]);

  useEffect(() => {
    if (ui.mode !== "app" || !userProfile?.id) return;
    void recoverPermanentMediaDecryption().catch(() => {
      addToast({ message: t("파일 암호화 해제 복구가 보류되었습니다. 암호화 원본은 보존됩니다.",
        "File decryption recovery is pending. The encrypted source is preserved.") });
    });
  }, [ui.mode, userProfile?.id, addToast]);

  const syncRefreshProfileId = userProfile?.id;
  useEffect(() => {
    if (ui.mode !== "app" || !syncRefreshProfileId || !getVaultKey()) return;
    const account = getActiveAccount().id;
    const vaultKey = getVaultKey();
    let disposed = false;
    let pending = false;
    let running = false;

    const eligible = () => !disposed && getActiveAccount().id === account && getVaultKey() === vaultKey &&
      useAppStore.getState().ui.mode === "app" && useAppStore.getState().userProfile?.id === syncRefreshProfileId;

    const drain = async () => {
      if (running) return;
      running = true;

      try {
        while (pending && eligible()) {
          pending = false;
          await hydrateVault();
        }
      } catch {
        // The source remains stored; another normal hydration can recover the view.
        console.warn("[sync] post-commit refresh failed");
      } finally { running = false; }
    };

    const unsubscribe = onAuthenticatedSyncTextStored((storedAccount) => {
      if (storedAccount !== account || !eligible()) return;
      pending = true;
      queueMicrotask(() => { void drain(); });
    });

    return () => { disposed = true; pending = false; unsubscribe(); };
  }, [ui.mode, syncRefreshProfileId, hydrateVault]);

  useEffect(() => {
    if (ui.mode !== "app") return;

    const runUpdate = () => {
      void runVerifiedTorAutoUpdate().catch((error) => {
        console.error("Verified Tor auto-update failed", error);
      });
    };

    runUpdate();
    const interval = window.setInterval(runUpdate, TOR_AUTO_UPDATE_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [ui.mode]);

  useEffect(() => {
    if (ui.mode !== "app") return;
    startFriendInboxListener((event) => {
      if (useAppStore.getState().ui.mode !== "app") return;

      if (event?.type === "profile_update") {
        const accountId = getActiveAccountId();
        const generation = getAccountOwnerGeneration();
        void listProfiles().then((profiles) => {
          if (getActiveAccountId() !== accountId || getAccountOwnerGeneration() !== generation) return;
          setFriends(profiles.filter((profile) => profile.kind === "friend"));
        });

        return;
      }

      void hydrateVault();

      if (event?.type === "friend_req") {
        addToast({ message: t("새 친구 요청이 도착했습니다.", "A new friend request arrived.") });
      }
    }, {
      getLocalFriendCode: async () => {
        const payload = await buildLocalFriendCodePayload();

        return encodeFriendCodeV1({ v: 1, ...payload });
      },
    });
  }, [addToast, buildLocalFriendCodePayload, hydrateVault, setFriends, ui.mode]);

  useEffect(() => {
    if (ui.mode !== "app") return;
    let disposed = false;
    let preparing = false;

    const prepare = async () => {
      if (disposed || preparing) return;
      preparing = true;

      try {
        const status = await getOnionStatus();

        if (status.runtime.status !== "running") return;
        await ensurePublishedLocalOnionEndpoint();
      } catch {
        // The next status event or timer retries publication readiness.
      } finally {
        preparing = false;
      }
    };

    void prepare();
    const unsubscribe = onBackgroundStatus(() => void prepare());
    const timer = window.setInterval(() => void prepare(), 5_000);

    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [ui.mode]);

  useEffect(() => {
    if (ui.mode !== "app") {
      routerBootstrapRunKeyRef.current = null;

      return;
    }

    const mode = netConfig.mode;
    const onionEnabled = netConfig.onionEnabled;
    const onionSelectedNetwork = netConfig.onionSelectedNetwork;
    const onionActive = mode === "onionRouter" || onionEnabled;

    const autoPrepareTor = shouldAutoPrepareTor({
      mode,
      onionEnabled,
      torAutoPrepareOnAppStart: netConfig.torAutoPrepareOnAppStart,
    });

    const runKey = `${ui.mode}:${String(onionActive)}:${onionSelectedNetwork}:${String(autoPrepareTor)}:${netConfig.torBridgeMode ?? "auto"}`;

    if (routerBootstrapRunKeyRef.current === runKey) return;
    routerBootstrapRunKeyRef.current = runKey;
    let cancelled = false;
    const operationId = `router-bootstrap:${newClientBatchId()}`;
    const startedAt = nowMonotonicMs();
    const elapsedMs = () => Math.max(0, Math.round(nowMonotonicMs() - startedAt));
    void (async () => {
      const runtimeBootstrap: RuntimeBootstrapDiagnostics = {};

      const baseContext = {
        mode,
        onionEnabled,
        onionSelectedNetwork,
        autoPrepareTor,
        torBridgeMode: netConfig.torBridgeMode ?? "auto",
      };

      emitRouterTestLog({
        status: "attempt",
        stage: "app-bootstrap:start",
        source: "app:routerBootstrap",
        operationId,
        elapsedMs: 0,
        context: {
          ...baseContext,
          onionActive,
        },
      });

      try {
        if (onionActive && !autoPrepareTor) {
          emitRouterTestLog({
            status: "ready",
            stage: "app-bootstrap:skipped",
            source: "app:routerBootstrap",
            operationId,
            elapsedMs: elapsedMs(),
            message: "Tor automatic preparation is disabled",
            context: baseContext,
          });

          return;
        }

        if (autoPrepareTor) {
          const torRuntime = TorRuntime.getInstance();
          const torStartupTimeoutMs = getTorStartupTimeoutMs(netConfig.torBridgeMode);

          try {
            await torRuntime.start({
              timeoutMs: torStartupTimeoutMs,
              bridgeMode: netConfig.torBridgeMode,
            });
            await torRuntime.awaitReady(torStartupTimeoutMs);
            runtimeBootstrap.torRuntimeState = torRuntime.getState();
            runtimeBootstrap.torDataDir = torRuntime.getDataDir();
            runtimeBootstrap.torSocksPort = (() => {
              const socks = torRuntime.getSocksUrl();

              if (!socks) return null;

              try {
                const parsed = new URL(socks);

                return parsed.port || null;
              } catch {
                return null;
              }
            })();
          } catch (error) {
            runtimeBootstrap.torRuntimeError =
              error instanceof Error ? error.message : String(error);
          }
        }

        const currentConfig = useNetConfigStore.getState().config;

        const warmupConfig = onionActive
          ? { ...currentConfig, mode: "onionRouter" as const }
          : currentConfig;

        const warmup = await prewarmRouter({ includeFallback: true, config: warmupConfig });

        if (!cancelled) {
          const runtimeSnapshot = await resolveRuntimeNetworkSnapshot();
          devLog("router:prewarm", {
            chosen: warmup.chosenTransport,
            requested: warmup.requested,
            started: warmup.started,
            failed: warmup.failed,
            mode: warmup.mode,
            onionEnabled: warmup.onionEnabled,
            onionSelectedNetwork: warmup.onionSelectedNetwork,
            runtimeBootstrap,
            runtimeSnapshot,
          });
          const selectedRuntimeState = runtimeSnapshot.torState;
          const selectedRuntimeDetail = runtimeSnapshot.torDetail;
          const routerOpened = warmup.started.includes("onionRouter");
          const warmupComplete = !onionActive || (selectedRuntimeState === "running" && routerOpened);
          emitRouterTestLog({
            status: warmupComplete ? "ready" : "failed",
            stage: "app-bootstrap:result",
            source: "app:routerBootstrap",
            operationId,
            elapsedMs: elapsedMs(),
            message: warmupComplete ? "Router prewarm completed" : "Router prewarm incomplete",
            error: warmupComplete
              ? undefined
              : `selectedRuntimeState:${selectedRuntimeState ?? "unknown"}|routerOpened:${String(routerOpened)}`,
            context: {
              ...baseContext,
              chosenTransport: warmup.chosenTransport,
              requestedTransports: warmup.requested,
              startedTransports: warmup.started,
              failedTransports: warmup.failed,
              runtimeBootstrap,
              runtimeSnapshot,
              selectedRuntimeState,
              selectedRuntimeDetail,
              routerOpened,
            },
          });

          if (onionActive && (selectedRuntimeState !== "running" || !routerOpened)) {
            const now = Date.now();

            if (now - onionBootstrapToastAtRef.current > 15_000) {
              onionBootstrapToastAtRef.current = now;
              addToast({
                message: routerOpened
                  ? t("Onion 네트워크가 아직 준비되지 않았습니다. 설정에서 Tor 상태를 확인해 주세요.", "The Onion network is not ready. Check Tor status in Settings.")
                  : t("Onion 라우터 초기화에 실패했습니다. 잠시 후 다시 시도하거나 네트워크 설정을 확인해 주세요.", "Could not initialize the Onion router. Try again later or check Network settings."),
              });
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          emitRouterTestLog({
            status: "failed",
            stage: "app-bootstrap:exception",
            source: "app:routerBootstrap",
            operationId,
            elapsedMs: elapsedMs(),
            error: error instanceof Error ? error.message : String(error),
            errorDetail: toInfoLogErrorDetail(error),
            context: {
              ...baseContext,
              runtimeBootstrap,
            },
          });
          console.error("Failed to bootstrap router warmup", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    addToast,
    devLog,
    emitRouterTestLog,
    netConfig.mode,
    netConfig.onionEnabled,
    netConfig.onionSelectedNetwork,
    netConfig.torBridgeMode,
    netConfig.torAutoPrepareOnAppStart,
    resolveRuntimeNetworkSnapshot,
    ui.mode,
  ]);

  useEffect(() => {
    if (ui.mode !== "app") return;

    if (
      !shouldAutoPrepareTor({
        mode: netConfig.mode,
        onionEnabled: netConfig.onionEnabled,
        torAutoPrepareOnAppStart: netConfig.torAutoPrepareOnAppStart,
      })
    ) {
      return;
    }

    let disposed = false;
    let preparing = false;

    const ensureTorPrepared = async () => {
      if (disposed || preparing) return;
      preparing = true;

      try {
        const current = await resolveRuntimeNetworkSnapshot();
        const torRuntime = TorRuntime.getInstance();
        const connection = getConnectionStatus();
        const config = useNetConfigStore.getState().config;
        const torStartupTimeoutMs = getTorStartupTimeoutMs(config.torBridgeMode);
        await restoreTorRouter({
          processRunning: current.torState === "running",
          runtimeReady: torRuntime.getState() === "READY",
          routerConnected: connection.state === "connected" && connection.transport === "onionRouter",
          cancelled: () => disposed,
          start: async () => {
            await torRuntime.start({ timeoutMs: torStartupTimeoutMs, bridgeMode: config.torBridgeMode });
            await torRuntime.awaitReady(torStartupTimeoutMs);
          },
          openRouter: () => prewarmRouter({ includeFallback: false, config: { ...config, mode: "onionRouter" } }),
        });
      } catch (error) {
        devLog("router:auto-prepare-retry", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        preparing = false;

        if (!disposed) {
          await refreshSidebarRuntimeSnapshot();
        }
      }
    };

    const timer = window.setInterval(() => {
      void ensureTorPrepared();
    }, 15_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    devLog,
    netConfig.mode,
    netConfig.onionEnabled,
    netConfig.torBridgeMode,
    netConfig.torAutoPrepareOnAppStart,
    refreshSidebarRuntimeSnapshot,
    resolveRuntimeNetworkSnapshot,
    ui.mode,
  ]);

  // cleanup 메모리 문제(EffectCallback) + unsubscribe 방어
  useEffect(() => {
    if (typeof window !== "undefined") {
      connectionToastShown.current = window.sessionStorage.getItem(connectionToastKey) === "1";
    }

    let prevConnected = false;

    const unsubscribe = onConnectionStatus((status) => {
      const connected = status.state === "connected";

      if (!connected || prevConnected) {
        prevConnected = connected;

        return;
      }

      if (ui.mode !== "app") {
        prevConnected = connected;

        return;
      }

      if (connectionToastShown.current) {
        prevConnected = connected;

        return;
      }

      addToast({ message: t("세션이 연결되었습니다.", "Session connected.") });
      connectionToastShown.current = true;

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(connectionToastKey, "1");
      }

      prevConnected = connected;
    });

    return () => {
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.error("Failed to unsubscribe connection status", e);
      }
    };
  }, [addToast, connectionToastKey, ui.mode]);

  const handleCreate = async (displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;
    const previousAccount = getActiveAccount();
    let createdAccountId: string | null = null;

    try {
      setOnboardingError("");
      devLog("onboarding:create:start");

      if (window.nkcExperimental?.recoveryV2) {
        const gate = window.nkcExperimental.preflight;

        if (!gate) throw new Error("PREFLIGHT_UNAVAILABLE");
        const status = await gate.status();

        if (status === "needs_prepare") {
          await gate.prepare();
          throw new Error("Restart NKC normally, then create this disposable account.");
        }

        if (status !== "verified") throw new Error(`PREFLIGHT_${status.toUpperCase()}`);
      }

      const account = createLocalAccount(displayName);
      createdAccountId = account.id;
      await resetRouterRuntime();
      await window.p2pQueue?.setActiveAccount(account.id, await acquireMainAccountSession(account.id));
      await withTimeout(switchVaultDb(account.dbName), "switchVaultDb");
      await withTimeout(clearStoredSession(), "clearStoredSession");
      await withTimeout(resetVaultStorage(), "resetVaultStorage");
      await withTimeout(bootstrapVault(), "bootstrapVault");

      const vk = getVaultKey();

      if (!vk) throw new Error("Vault key missing after bootstrap.");

      await withTimeout(
        Promise.all([getOrCreateIdentityKeypair(), getOrCreateDhKeypair()]).then(() => undefined),
        "ensureDeviceKeys"
      );
      getOrCreateDeviceId();

      const now = Date.now();

      const user: UserProfile = {
        id: createId(),
        displayName,
        status: "Hello from NKC",
        presence: createProfilePresence("online"),
        theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
        kind: "user",
        createdAt: now,
        updatedAt: now,
      };

      await saveProfile(user);
      renameActiveAccount(user.displayName);
      await withTimeout(setStoredSession(vk), "setStoredSession");
      navigate("/start-key");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Vault bootstrap failed", error);
      setOnboardingError(t("계정을 생성하지 못했습니다. 로컬 계정 수와 저장 공간을 확인하고 다시 시도해 주세요.", "Could not create your account. Check the local account limit and available storage, then try again."));
      lockVault();

      if (createdAccountId) {
        await window.p2pQueue?.removeAccount(createdAccountId, await acquireMainAccountSession(getActiveAccount().id)).catch(() => undefined);
        removeLocalAccount(createdAccountId);
        activateAccount(previousAccount.id);
        await window.p2pQueue?.setActiveAccount(previousAccount.id, await acquireMainAccountSession(previousAccount.id)).catch(() => undefined);
        await switchVaultDb(previousAccount.dbName);
        await deleteVaultDatabase(`nkc_vault_${createdAccountId.replace(/-/g, "")}`).catch(
          () => undefined
        );
      }

      setMode("onboarding");
      addToast({ message: t("금고 초기화에 실패했습니다.", "Could not initialize the vault. Please try again.") });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handleStartKeyUnlock = async (startKey: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;

    if (!validateStartKey(startKey)) {
      addToast({ message: t("시작 키 형식이 올바르지 않습니다. (예: NKC-...)", "Invalid start key. Enter the full key starting with NKC-.") });
      onboardingLockRef.current = false;

      return;
    }

    try {
      setOnboardingError("");
      devLog("onboarding:start-key:start");

      const previousAccount = getActiveAccount();

      const matchedAccount = await findMatchingLocalAccount(async (account) => {
        try {
          await switchVaultDb(account.dbName);

          return await withTimeout(
            verifyStartKeyForCurrentVault(startKey),
            "verifyStartKeyForCurrentVault"
          );
        } catch (error) {
          console.warn("[account] start-key comparison failed", {
            accountId: account.id,
            error,
          });

          return false;
        }
      }, previousAccount.id);

      if (!matchedAccount) {
        await switchVaultDb(previousAccount.dbName);
        throw new Error("이 기기에서 시작 키와 일치하는 계정을 찾을 수 없습니다.");
      }

      activateAccount(matchedAccount.id);
      await resetRouterRuntime();
      await window.p2pQueue?.setActiveAccount(matchedAccount.id, await acquireMainAccountSession(matchedAccount.id));
      await clearStoredSession();
      lockVault();
      await switchVaultDb(matchedAccount.dbName);
      await withTimeout(unlockVault(startKey), "unlockVault");

      const vk = getVaultKey();

      if (!vk) throw new Error("Vault key missing after unlock.");

      await withTimeout(
        Promise.all([getOrCreateIdentityKeypair(), getOrCreateDhKeypair()]).then(() => undefined),
        "ensureDeviceKeys"
      );
      getOrCreateDeviceId();

      const profiles = await withTimeout(listProfiles(), "listProfiles");

      if (!profiles.length) {
        throw new Error("기존 계정 프로필을 찾을 수 없습니다.");
      }

      await withTimeout(setStoredSession(vk), "setStoredSession");
      await storeStartKey(startKey);
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Start key unlock failed", error);
      await switchVaultDb(getActiveAccount().dbName).catch((restoreError) => {
        console.error("Failed to restore active account database", restoreError);
      });
      setOnboardingError(
        t("시작 키로 잠금 해제에 실패했습니다. 이 계정의 전체 시작 키를 확인해 주세요.", "Could not unlock. Check the complete start key for this account.")
      );
      lockVault();
      setMode("onboarding");
      addToast({ message: t("시작 키로 잠금 해제에 실패했습니다.", "Could not unlock with this start key. Check the key and try again.") });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handlePinUnlock = async (pin: string): Promise<UnlockResult> => {
    const accountId = getActiveAccountId();
    let generation = getAccountOwnerGeneration();
    const assertOwner = () => {
      if (accountId !== getActiveAccountId() || generation !== getAccountOwnerGeneration()) throw new Error("OWNER_SESSION_CHANGED");
    };
    const result = await verifyPin(pin);
    assertOwner();

    if (!result.ok) {
      if (result.reason === "unavailable") {
        return {
          ok: false,
          reason: "unavailable",
          error: result.message || "PIN lock is unavailable on this platform/build.",
        };
      }

      if (result.reason === "not_set") {
        return {
          ok: false,
          reason: "not_set",
          error: "PIN 정보가 없습니다. 시작 키로 재설정해주세요.",
        };
      }

      const reason = result.reason === "locked" ? "locked" : "mismatch";

      return {
        ok: false,
        reason,
        error:
          reason === "locked"
            ? "잠시 후 다시 시도해주세요."
            : "PIN이 올바르지 않습니다.",
        retryAfterMs: result.retryAfterMs,
      };
    }

    try {
      const keyOk = await verifyVaultKeyId(result.vaultKey);
      assertOwner();

      if (!keyOk) {
        await clearPinRecord();
        setPinEnabled(true);
        setPinNeedsReset(true);

        return {
          ok: false,
          reason: "not_set",
          error: "PIN이 현재 금고와 일치하지 않습니다. 시작 키로 재설정하세요.",
        };
      }

      setVaultKey(result.vaultKey);
      generation = getAccountOwnerGeneration();
      await setStoredSession(result.vaultKey);
      assertOwner();
      await hydrateVault();
      assertOwner();
      navigate("/");

      return { ok: true };
    } catch (error) {
      if (accountId !== getActiveAccountId() || generation !== getAccountOwnerGeneration()) return { ok: false, error: "Account session changed." };
      console.error("PIN unlock hydrate failed", error);
      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);

      return { ok: false, error: "잠금 해제에 실패했습니다." };
    }
  };

  const handleLock = useCallback(async () => {
    let enabled = pinEnabled;
    let needsReset = pinNeedsReset;

    // Re-sync with the source of truth in case local state is stale.
    if (!enabled || needsReset) {
      try {
        const pinStatus = await getPinStatus();
        enabled = pinStatus.enabled;
        needsReset = pinStatus.needsReset;
        setPinEnabled(enabled);
        setPinNeedsReset(needsReset);
      } catch (error) {
        console.error("Failed to read PIN status before lock", error);
      }
    }

    if (!enabled || needsReset) {
      if (needsReset) {
        addToast({ message: t("PIN을 재설정한 후 잠금을 사용해 주세요.", "Reset your PIN to enable lock.") });

        return;
      }

      addToast({ message: t("PIN을 설정한 후 잠금을 사용해 주세요.", "Set a PIN to enable lock.") });

      return;
    }

    try {
      await clearStoredSession();
      lockVault();
      resetAppState();
      setMode("locked");
      navigate("/unlock");
    } catch (error) {
      console.error("Failed to lock", error);
      addToast({ message: t("잠그지 못했습니다. 다시 시도해 주세요.", "Lock failed.") });
    }
  }, [
    addToast,
    navigate,
    pinEnabled,
    pinNeedsReset,
    resetAppState,
    setMode,
    setPinEnabled,
    setPinNeedsReset,
  ]);

  useEffect(() => {
    if (!pinEnabled || pinNeedsReset || ui.mode !== "app") return;

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;

        return;
      }

      if (document.visibilityState === "visible" && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        void handleLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [handleLock, pinEnabled, pinNeedsReset, ui.mode]);

  const handleLogout = async () => {
    try {
      friendRequestInFlightRef.current.clear();
      stopOutboxScheduler();
      outboxSchedulerStarted.current = false;
      await resetRouterRuntime();
      resetAppState();
      await clearStoredSession();
      lockVault();

      const pinStatus = await getPinStatus();
      setPinEnabled(pinStatus.enabled);
      setPinNeedsReset(pinStatus.needsReset);

      if (pinStatus.enabled && !pinStatus.needsReset) {
        setMode("locked");
        navigate("/unlock");
      } else {
        if (pinStatus.needsReset) {
          addToast({ message: t("PIN을 재설정해야 합니다. 시작 키로 로그인해 주세요.", "PIN must be reset. Unlock with the start key.") });
        }

        setDefaultTab("startKey");
        setMode("onboarding");
        navigate("/");
      }
    } catch (error) {
      console.error("Failed to logout", error);
      addToast({ message: t("로그아웃에 실패했습니다.", "Could not sign out.") });
    }
  };

  const handleSetPin = async (pin: string) => {
    try {
      await savePin(pin);
      setPinEnabled(true);
      setPinNeedsReset(false);
      addToast({ message: t("PIN을 설정했습니다.", "PIN set.") });

      return { ok: true as const };
    } catch (error) {
      if (isPinUnavailableError(error)) {
        return {
          ok: false as const,
          error: "PIN lock is unavailable on this platform/build.",
        };
      }

      const message = String((error as { message?: unknown })?.message ?? error);
      console.error("Failed to set PIN", message);

      return {
        ok: false as const,
        error: message || "Failed to set PIN.",
      };
    }
  };

  const handleDisablePin = async () => {
    try {
      await clearPin();
      const status = await getPinStatus();

      if (status.enabled) {
        throw new Error("PIN disable did not persist");
      }

      setPinEnabled(false);
      setPinNeedsReset(false);
      addToast({ message: t("PIN 잠금을 해제했습니다.", "PIN disabled.") });
    } catch (error) {
      if (isPinUnavailableError(error)) {
        addToast({ message: t("이 기기에서는 PIN 잠금을 사용할 수 없습니다.", "PIN lock is unavailable on this platform/build.") });
        throw error;
      }

      console.error("Failed to clear PIN", error);
      addToast({ message: t("PIN 잠금을 해제하지 못했습니다.", "Failed to disable PIN.") });
      throw error;
    }
  };

  const handleRotateStartKey = useCallback(async (newKey: string) => {
    try {
      if (!validateStartKey(newKey)) {
        addToast({ message: t("시작 키 형식이 올바르지 않습니다. (예: NKC-...)", "Invalid start key. Enter the full key starting with NKC-.") });

        return;
      }

      const context = await captureLocalOperationContext();

      if (!context) throw new Error("OWNER_REQUIRED");
      await rotateVaultKeys(newKey, () => {}, context.vault);
      const vk = getVaultKey();

      if (vk) await setStoredSession(vk);

      const nextPinState = await reconcilePinAfterStartKeyRotation();
      setPinEnabled(nextPinState.enabled);
      setPinNeedsReset(nextPinState.needsReset);

      addToast({
        message: nextPinState.needsReset
          ? t("시작 키가 변경되었습니다. PIN을 다시 설정해 주세요.", "Start key changed. Please reset your PIN.")
          : location.pathname === "/start-key"
            ? t("시작 키 저장을 완료했습니다. 친구 코드를 추가해 대화를 시작하세요.", "Start key saved. Add a friend code to start chatting.")
            : t("시작 키가 변경되었습니다.", "Start key changed."),
      });
    } catch (error) {
      console.error("Failed to rotate start key", error);
      addToast({ message: t("시작 키 변경에 실패했습니다.", "Could not change your start key.") });
      throw error;
    }
  }, [addToast, location.pathname]);

  const handleSaveProfile = async (payload: {
    displayName: string;
    status: string;
    theme: "dark" | "light";
    presenceStatus?: PresenceStatus;
    avatarFile?: File;
  }) => {
    if (!userProfile) return;

    const ownerGeneration = getAccountOwnerGeneration();
    const ownerAccountId = getActiveAccountId();
    const context = await captureLocalOperationContext();

    if (!context) throw new Error("OWNER_REQUIRED");
    if (context.owner.accountId !== ownerAccountId || getAccountOwnerGeneration() !== ownerGeneration) {
      throw new Error("OWNER_SESSION_CHANGED");
    }
    const previousProfile = (await listProfiles(context.vault)).find(profile => profile.kind === "user" && profile.id === userProfile.id);

    if (!previousProfile) throw new Error("OWNER_PROFILE_MISMATCH");
    let updated: UserProfile = {
      ...previousProfile,
      displayName: payload.displayName,
      status: payload.status,
      theme: payload.theme,
      avatarRef: previousProfile.avatarRef,
      presence: createProfilePresence(payload.presenceStatus ?? previousProfile.presence?.status ?? "online"),
      updatedAt: Date.now(),
    };

    if (payload.avatarFile) updated = await saveProfileWithPhoto(updated, previousProfile, payload.avatarFile, context.vault);
    else await saveProfile(updated, context.vault, previousProfile);
    context.vault.assertLocal();
    renameActiveAccount(updated.displayName);
    setUserProfile(updated);

    if (updated.theme !== previousProfile.theme) await applyDocumentTheme(updated.theme, true, context.vault.assertLocal);
    context.vault.assertLocal();
    void profileBroadcastRef.current(updated, Boolean(payload.avatarFile)).catch((error) =>
      console.warn("[profile] update broadcast failed", error)
    );
  };

  const handleToggleTheme = async () => {
    if (!userProfile) return;
    const nextTheme = userProfile.theme === "dark" ? "light" : "dark";
    await handleSaveProfile({
      displayName: userProfile.displayName,
      status: userProfile.status ?? "",
      theme: nextTheme,
      presenceStatus: userProfile.presence?.status ?? "online",
    });
  };

  const recoverRoutingHintsFromFriendCode = useCallback((profile: UserProfile) => {
    const code = profile.profileVcard?.friendCode?.trim();

    if (!code) return undefined;
    const decoded = decodeFriendCodeV1(code);

    if ("error" in decoded) return undefined;

    return sanitizeRoutingHints({
      deviceId: decoded.deviceId,
      onionAddr: decoded.onionAddr,
      inboxWriteToken: decoded.inboxWriteToken,
    });
  }, []);

  const buildResolvedRoutingMeta = useCallback(
    (profile: UserProfile) => {
      const recovered = recoverRoutingHintsFromFriendCode(profile);

      const toDeviceId =
        profile.routingHints?.deviceId ??
        profile.primaryDeviceId ??
        profile.deviceId ??
        recovered?.deviceId;

      const torOnion = profile.routingHints?.onionAddr ?? recovered?.onionAddr;

      const inboxWriteToken =
        profile.routingHints?.inboxWriteToken ?? recovered?.inboxWriteToken;

      return {
        toDeviceId,
        route: torOnion ? { torOnion, inboxWriteToken } : undefined,
      };
    },
    [recoverRoutingHintsFromFriendCode]
  );

  const recoverAndPersistFriendRouting = useCallback(
    async (friend: UserProfile, context: ReceiveContext) => {
      context.vault.assertLocal();
      const recovered = recoverRoutingHintsFromFriendCode(friend);

      if (!recovered) return friend;

      const mergedHints = sanitizeRoutingHints({
        deviceId: friend.routingHints?.deviceId ?? recovered.deviceId,
        onionAddr: friend.routingHints?.onionAddr ?? recovered.onionAddr,
        inboxWriteToken:
          friend.routingHints?.inboxWriteToken ?? recovered.inboxWriteToken,
      });

      const mergedPrimaryDeviceId = friend.primaryDeviceId ?? friend.deviceId ?? recovered.deviceId;
      const nextRoutingHints = mergedHints ?? friend.routingHints;

      const changed =
        !sameRoutingHints(nextRoutingHints, friend.routingHints) ||
        (mergedPrimaryDeviceId ?? "") !== (friend.primaryDeviceId ?? "");

      if (!changed) return friend;

      const updated: UserProfile = {
        ...friend,
        routingHints: nextRoutingHints,
        primaryDeviceId: mergedPrimaryDeviceId,
        updatedAt: Date.now(),
      };

      await saveProfile(updated, context.vault, friend);

      return updated;
    },
    [recoverRoutingHintsFromFriendCode]
  );

  const buildRoutingMeta = useCallback((partner: UserProfile) => {
    return buildResolvedRoutingMeta(partner);
  }, [buildResolvedRoutingMeta]);

  const markFriendRequestReachability = useCallback(
    async (
      friendId: string,
      patch: Partial<NonNullable<UserProfile["reachability"]>>
    ) => {
      const latest = useAppStore.getState().friends.find((item) => item.id === friendId);

      if (!latest) return;
      await saveProfile({
        ...latest,
        reachability: {
          ...(latest.reachability ?? { status: "unreachable" as const }),
          ...patch,
        },
        updatedAt: Date.now(),
      });
      await hydrateVault();
    },
    [hydrateVault]
  );

  const sendDirectEnvelope = useCallback(
    (conv: Conversation, partner: UserProfile, body: unknown, priority: "high" | "normal" = "high",
      options?: DirectEnvelopeOptions) => sendOwnedDirectEnvelope(conv, partner, body, priority, options, buildRoutingMeta(partner)),
    [buildRoutingMeta]
  );

  const buildFriendRequestPayload = useCallback(async (
    convId: string,
    traceId?: string,
    reconnect = false,
    context?: ReceiveContext
  ) => {
    if (!userProfile) return null;
    const payload = await buildLocalFriendCodePayload(context);
    const avatar = await encodeProfileAvatar(userProfile, context);

    const friendCode = encodeFriendCodeV1({
      v: 1,
      ...payload,
    });

    const privacyPrefs = await getPrivacyPrefs(context);

    return {
      type: "friend_req" as const,
      ...(reconnect ? { reconnect: true } : {}),
      convId,
      traceId,
      from: {
        identityPub: payload.identityPub,
        dhPub: payload.dhPub,
        deviceId: payload.deviceId,
        friendCode,
      },
      profile: {
        displayName: userProfile.displayName,
        status: userProfile.status,
        avatarRef: userProfile.avatarRef,
        ...(avatar ? { avatar } : {}),
        presence: createSharedProfilePresence(
          userProfile.presence?.status ?? "online",
          privacyPrefs.hidePresence
        ),
      },
      ts: Date.now(),
    };
  }, [buildLocalFriendCodePayload, userProfile]);

  const ensureDirectConvForFriend = useCallback(
    async (friend: UserProfile, context: ReceiveContext) => {
      context.vault.assertLocal();
      if (!userProfile) return null;
      if (!(await listProfiles(context.vault)).some(profile => profile.kind === "user" &&
          profile.id === userProfile.id)) throw new Error("OWNER_PEER_MISMATCH");

      const existingConv = (await listConversations(context.vault)).find(
        (conv) =>
          !(conv.type === "group" || conv.participants.length > 2) &&
          conv.participants.includes(friend.id)
      );

      if (existingConv) return existingConv;
      const now = Date.now();

      const newConv: Conversation = {
        id: createId(),
        type: "direct",
        name: friend.displayName,
        pinned: friend.isFavorite ?? false,
        unread: 0,
        hidden: false,
        muted: false,
        blocked: false,
        pendingOutgoing: friend.friendStatus === "request_out",
        lastTs: now,
        lastMessage: "친구 요청을 보냈습니다.",
        participants: [userProfile.id, friend.id],
      };

      return newConv;
    },
    [userProfile]
  );

  const sendFriendControlPacket = useCallback(
    async (
      conv: Conversation,
      partner: UserProfile,
      payload: unknown,
      context: ReceiveContext,
      priority: "high" | "normal" = "high"
    ) => {
      if (!isFriendControlFrame(payload)) {
        throw new Error("Unsupported friend control frame");
      }
      await context.vault.assertMain();
      const [identityPub, dhPub, profiles, conversations] = await Promise.all([
        getIdentityPublicKey(context), getDhPublicKey(context), listProfiles(context.vault), listConversations(context.vault),
      ]);
      const currentPeer = profiles.find(profile => profile.kind === "friend" && profile.id === partner.id &&
        profile.identityPub === partner.identityPub && profile.dhPub === partner.dhPub);
      const currentConversation = conversations.find(item => item.id === conv.id);
      const localUser = profiles.find(profile => profile.kind === "user");
      if (!currentPeer || !currentPeer.identityPub || !currentPeer.dhPub || !localUser || !currentConversation || currentConversation.type === "group" ||
          currentConversation.participants.length !== 2 || !currentConversation.participants.includes(currentPeer.id) ||
          !currentConversation.participants.includes(localUser.id) || (payload.convId && payload.convId !== conv.id) ||
          payload.from.identityPub !== encodeBase64Url(identityPub) || payload.from.dhPub !== encodeBase64Url(dhPub) ||
          (payload.from.deviceId && payload.from.deviceId !== getOrCreateDeviceId(context))) throw new Error("OWNER_PEER_MISMATCH");
      if (payload.type === "friend_decline" ? currentPeer.friendStatus !== "blocked" :
          currentPeer.friendStatus === "blocked" || currentPeer.friendStatus === "deleted") throw new Error("FRIEND_APPROVAL_STATE_CHANGED");

      const unsignedPayload = stripFriendControlFrameSignature(payload);
      let signedPayload: FriendControlFrame;

      if (payload.sig) {
        signedPayload = payload;
      } else {
        const identityPriv = await getIdentityPrivateKey(context);

        const protocolReadyPayload = await enrichFriendControlFrameWithProtocol(
          unsignedPayload,
          identityPriv,
          {
            pskHint: partner.friendId ?? partner.id,
            localDhPriv: await getDhPrivateKey(context),
            localFriendCode: unsignedPayload.from.friendCode,
            remoteFriendCode: partner.profileVcard?.friendCode,
            remoteIdentityPub: partner.identityPub,
            remoteDhPub: partner.dhPub,
            remoteDeviceId: partner.routingHints?.deviceId ?? partner.primaryDeviceId,
            remoteOnionAddr: partner.routingHints?.onionAddr,
          }
        );

        signedPayload = {
          ...protocolReadyPayload,
          sig: await signFriendControlFrame(protocolReadyPayload, identityPriv),
        };
      }

      const frameType = signedPayload.type;
      const traceId = signedPayload.traceId;
      const messageId = createId();

      if (frameType === "friend_req") firstMessageMeasurement.friendSend(messageId);
      const operationId = `friend-route:${newClientBatchId()}`;
      const startedAt = nowMonotonicMs();
      const elapsedMs = () => Math.max(0, Math.round(nowMonotonicMs() - startedAt));
      const routingMeta = buildRoutingMeta(currentPeer);

      const toDeviceIdSource = partner.routingHints?.deviceId
        ? "routingHints.deviceId"
        : partner.primaryDeviceId
          ? "primaryDeviceId"
          : partner.deviceId
            ? "deviceId"
            : partner.profileVcard?.friendCode
              ? "profileVcard.friendCode"
              : "none";

      const payloadHasSigBeforeSign = Boolean(
        payload?.sig
      );

      const payloadJson = JSON.stringify(signedPayload);
      const payloadByteLength = new TextEncoder().encode(payloadJson).byteLength;
      const netConfig = useNetConfigStore.getState().config;

      const hasExplicitOnionRoute = Boolean(
        routingMeta.route?.torOnion
      );

      // Friend-control frames establish the relationship itself, so they cannot depend on an
      // already-established self-onion relay path. Route them directly to the endpoint embedded
      // in the friend code; normal chat traffic continues to use the configured mode.
      const routingConfig = hasExplicitOnionRoute
        ? { ...netConfig, mode: "onionRouter" as const }
        : netConfig;

      const shouldPrewarmOnionRoute =
        hasExplicitOnionRoute;

      let prewarmResult: Awaited<ReturnType<typeof prewarmRouter>> | null = null;

      if (shouldPrewarmOnionRoute) {
        emitRouterTestLog({
          status: "attempt",
          stage: "friend-control:prewarm:start",
          source: "app:sendFriendControlPacket",
          operationId,
          elapsedMs: elapsedMs(),
          context: {
            frameType,
            convId: conv.id,
            partnerProfileId: partner.id,
            onionSelectedNetwork: routingConfig.onionSelectedNetwork,
            hasTorOnion: Boolean(routingMeta.route?.torOnion),
          },
        });

        try {
          prewarmResult = await withTimeout(
            prewarmRouter({
              config: routingConfig,
              includeFallback: true,
            }),
            "friend-control:prewarm",
            FRIEND_ROUTE_SEND_DEADLINE_MS
          );
          const prewarmOpened = prewarmResult.started.includes("onionRouter");
          emitRouterTestLog({
            status: prewarmOpened ? "ready" : "failed",
            stage: "friend-control:prewarm:result",
            source: "app:sendFriendControlPacket",
            operationId,
            elapsedMs: elapsedMs(),
            message: prewarmOpened
              ? "Friend control prewarm opened onion router"
              : "Friend control prewarm failed to open onion router",
            error: prewarmOpened ? undefined : prewarmResult.failed.join(" || "),
            context: {
              frameType,
              convId: conv.id,
              partnerProfileId: partner.id,
              chosenTransport: prewarmResult.chosenTransport,
              requestedTransports: prewarmResult.requested,
              startedTransports: prewarmResult.started,
              failedTransports: prewarmResult.failed,
            },
          });
        } catch (error) {
          emitRouterTestLog({
            status: "failed",
            stage: "friend-control:prewarm:exception",
            source: "app:sendFriendControlPacket",
            operationId,
            elapsedMs: elapsedMs(),
            error: error instanceof Error ? error.message : String(error),
            errorDetail: toInfoLogErrorDetail(error),
            context: {
              frameType,
              convId: conv.id,
              partnerProfileId: partner.id,
            },
          });

          return false;
        }
      }

      const runtimeSnapshot = await resolveRuntimeNetworkSnapshot();

      const senderDeviceId =
        signedPayload.from?.deviceId ?? getOrCreateDeviceId();

      const commonContext = {
        priority,
        partnerProfileId: partner.id,
        partnerFriendId: partner.friendId,
        partnerFriendStatus: partner.friendStatus,
        partnerReachabilityStatus: partner.reachability?.status ?? null,
        hasToDeviceId: Boolean(routingMeta.toDeviceId),
        hasTorOnion: Boolean(routingMeta.route?.torOnion),
        hasRoutingHintDeviceId: Boolean(partner.routingHints?.deviceId || routingMeta.toDeviceId),
        hasPrimaryDeviceId: Boolean(partner.primaryDeviceId),
        hasLegacyDeviceId: Boolean(partner.deviceId),
        toDeviceIdSource,
        hasRoutingHintOnion: Boolean(partner.routingHints?.onionAddr || routingMeta.route?.torOnion),
        convPendingOutgoing: Boolean(conv.pendingOutgoing),
        convPendingAcceptance: Boolean(conv.pendingAcceptance),
        convPendingFriendResponse: conv.pendingFriendResponse ?? null,
        payloadHasSigBeforeSign,
        payloadHasSigAfterSign: Boolean(signedPayload.sig),
        payloadByteLength,
        payloadTimestamp: signedPayload.ts ?? null,
        payloadConvId: signedPayload.convId ?? null,
        payloadTraceId: traceId ?? null,
        netMode: netConfig.mode,
        effectiveNetMode: routingConfig.mode,
        routeModeOverride: null,
        prewarmChosenTransport: prewarmResult?.chosenTransport ?? null,
        prewarmStartedTransports: prewarmResult?.started ?? null,
        prewarmFailedTransports: prewarmResult?.failed ?? null,
        onionEnabled: netConfig.onionEnabled,
        onionSelectedNetwork: netConfig.onionSelectedNetwork,
        onionProxyEnabled: netConfig.onionProxyEnabled,
        webrtcRelayOnly: netConfig.webrtcRelayOnly,
        disableLinkPreview: netConfig.disableLinkPreview,
        torStatus: netConfig.tor?.status ?? null,
        torRuntimeState: runtimeSnapshot.torState,
        torRuntimeDetail: runtimeSnapshot.torDetail,
      };

      let result:
        | Awaited<ReturnType<typeof sendCiphertext>>
        | null = null;

      emitFriendRouteTestLog({
        direction: "outgoing",
        status: "attempt",
        frameType,
        source: "app:sendFriendControlPacket",
        operationId,
        traceId,
        elapsedMs: 0,
        messageId,
        convId: conv.id,
        senderDeviceId,
        toDeviceId: routingMeta.toDeviceId,
        torOnion: routingMeta.route?.torOnion,
        context: {
          ...commonContext,
          checkpoint: "sendCiphertext:start",
        },
      });

      try {
        await context.vault.assertMain();
        result = await withTimeout(
          sendCiphertext(
            {
              access: context.vault,
              recipientIdentityPub: currentPeer.identityPub,
              convId: conv.id,
              messageId,
              ciphertext: payloadJson,
              priority,
              ...routingMeta,
            },
            { config: routingConfig }
          ),
          "friend-control:send",
          FRIEND_ROUTE_SEND_DEADLINE_MS
        );
      } catch (error) {
        const thrownMessage = error instanceof Error ? error.message : String(error);
        const errorParts = splitRouteErrorParts(thrownMessage);
        const normalizedErrorParts = errorParts.length > 0 ? errorParts : [thrownMessage];
        const errorCodes = collectRouteErrorCodes(normalizedErrorParts);
        emitFriendRouteTestLog({
          direction: "outgoing",
          status: "failed",
          frameType,
          messageId,
          convId: conv.id,
          source: "app:sendFriendControlPacket",
          operationId,
          traceId,
          elapsedMs: elapsedMs(),
          senderDeviceId,
          toDeviceId: routingMeta.toDeviceId,
          torOnion: routingMeta.route?.torOnion,
          error: `sendCiphertext threw: ${thrownMessage}`,
          errorDetail: toInfoLogErrorDetail(error),
          context: {
            ...commonContext,
            checkpoint: "sendCiphertext:throw",
            errorParts: normalizedErrorParts,
            errorCodes,
            failureClass: classifyRouteFailure(errorCodes, normalizedErrorParts),
          },
        });

        return false;
      }

      const retriedWithRouterWarmup = false;
      const finalErrorMessage = result.error ?? "Friend control packet send failed";

      if (!result.ok) {
        const errorMessage = finalErrorMessage;
        const errorParts = splitRouteErrorParts(errorMessage);
        const normalizedErrorParts = errorParts.length > 0 ? errorParts : [errorMessage];
        const errorCodes = collectRouteErrorCodes(normalizedErrorParts);
        emitFriendRouteTestLog({
          direction: "outgoing",
          status: "failed",
          frameType,
          source: "app:sendFriendControlPacket",
          operationId,
          traceId,
          elapsedMs: elapsedMs(),
          via: result.transport,
          messageId,
          convId: conv.id,
          senderDeviceId,
          toDeviceId: routingMeta.toDeviceId,
          torOnion: routingMeta.route?.torOnion,
          error: errorMessage,
          context: {
            ...commonContext,
            checkpoint: "sendCiphertext:result-not-ok",
            errorParts: normalizedErrorParts,
            errorCodes,
            failureClass: classifyRouteFailure(errorCodes, normalizedErrorParts),
            routerDiagnostic: result.diagnostic ?? null,
            retriedWithRouterWarmup,
            ...(frameType === "friend_req"
              ? {
                  peerReceiptConfirmed: false,
                  receiptConfirmation: "awaiting-friend_accept-or-friend_decline",
                }
              : {}),
          },
        });

        return false;
      }

      emitFriendRouteTestLog({
        direction: "outgoing",
        status: "sent",
        frameType,
        source: "app:sendFriendControlPacket",
        operationId,
        traceId,
        elapsedMs: elapsedMs(),
        via: result.transport,
        messageId,
        convId: conv.id,
        senderDeviceId,
        toDeviceId: routingMeta.toDeviceId,
        torOnion: routingMeta.route?.torOnion,
        context: {
          ...commonContext,
          checkpoint: "sendCiphertext:result-ok",
          finalVia: result.transport,
          routerDiagnostic: result.diagnostic ?? null,
          ...(frameType === "friend_req"
            ? {
                peerReceiptConfirmed: false,
                receiptConfirmation: "awaiting-friend_accept-or-friend_decline",
              }
            : {}),
        },
      });

      return true;
    },
    [buildRoutingMeta, emitFriendRouteTestLog, emitRouterTestLog, resolveRuntimeNetworkSnapshot, withTimeout]
  );

  const broadcastProfileUpdate = useCallback(
    async (profile: UserProfile, includeAvatar: boolean, owner: { accountId: string; generation: number }) => {
      const context = await captureLocalOperationContext();

      if (!context) throw new Error("OWNER_REQUIRED");
      if (context.owner.accountId !== owner.accountId || getAccountOwnerGeneration() !== owner.generation) return;
      const profiles = await listProfiles(context.vault);
      const current = profiles.find(item => item.kind === "user" && item.id === profile.id);
      if (!current || current.updatedAt !== profile.updatedAt || current.displayName !== profile.displayName ||
          current.status !== profile.status || JSON.stringify(current.avatarRef) !== JSON.stringify(profile.avatarRef)) return;
      const root = await getAccountRootIdentity(context);
      const privacyPrefs = await getPrivacyPrefs(context);

      const presence = createSharedProfilePresence(
        profile.presence?.status ?? "online",
        privacyPrefs.hidePresence
      );

      const timestamp = presence.updatedAt;
      const targets = profiles.filter(
        (friend) => friend.kind === "friend" && friend.friendStatus === "normal" && friend.identityPub && friend.dhPub
      );

      if (!targets.length) return;

      if (root) {
        const avatar = includeAvatar ? await encodeProfileAvatar(profile, context) : undefined;
        await sendAccountProfile(profile, { displayName: profile.displayName, status: profile.status, presence,
          ...(avatar ? { avatar } : {}) }, context);

        return;
      }

      const [localRoute, avatar] = await Promise.all([
        buildLocalFriendCodePayload(context),
        includeAvatar ? encodeProfileAvatar(profile, context) : undefined,
      ]);

      const friendCode = encodeFriendCodeV1({ v: 1, ...localRoute });
      const conversations = await listConversations(context.vault);

      for (const friend of targets) {
        const conv = conversations.find(
          (item) =>
            !(item.type === "group" || item.participants.length > 2) &&
            item.participants.includes(friend.id)
        );

        if (!conv) continue;

        const frame: FriendControlFrame = {
          type: "profile_update",
          convId: conv.id,
          traceId: `profile-update:${newClientBatchId()}`,
          from: {
            identityPub: localRoute.identityPub,
            dhPub: localRoute.dhPub,
            deviceId: localRoute.deviceId,
            friendCode,
          },
          profile: {
            displayName: profile.displayName,
            status: profile.status,
            presence,
            ...(avatar ? { avatar } : {}),
          },
          ts: timestamp,
        };

        const nextKind = avatar ? "avatar" : "metadata";

        const superseded = (await listOutboxByConv(conv.id, context.vault)).filter((record) => {
          const kind = getSerializedProfileUpdateKind(legacyOutboxCiphertext(record));

          return kind !== null && (nextKind === "avatar" || kind === "metadata");
        });

        await Promise.all(superseded.map((record) => deleteOutbox(record.id, context.vault)));
        await sendFriendControlPacket(conv, friend, frame, context, "normal");
      }
    },
    [buildLocalFriendCodePayload, sendFriendControlPacket]
  );

  const queueProfileUpdate = useCallback(
    (profile: UserProfile, includeAvatar = false) => {
      const pending = pendingProfileBroadcastRef.current;
      const accountId = getActiveAccountId(), generation = getAccountOwnerGeneration();
      pendingProfileBroadcastRef.current = {
        profile, accountId, generation,
        includeAvatar: includeAvatar || (pending?.accountId === accountId && pending.generation === generation && pending.includeAvatar),
      };

      if (profileBroadcastInFlightRef.current) return profileBroadcastInFlightRef.current;

      const run = (async () => {
        while (pendingProfileBroadcastRef.current) {
          const next = pendingProfileBroadcastRef.current;
          pendingProfileBroadcastRef.current = null;
          if (getActiveAccountId() !== next.accountId || getAccountOwnerGeneration() !== next.generation) continue;
          try { await broadcastProfileUpdate(next.profile, next.includeAvatar, next); }
          catch (error) {
            if (getActiveAccountId() === next.accountId && getAccountOwnerGeneration() === next.generation) throw error;
          }
        }
      })().finally(() => {
        profileBroadcastInFlightRef.current = null;
      });

      profileBroadcastInFlightRef.current = run;

      return run;
    },
    [broadcastProfileUpdate]
  );

  useEffect(() => {
    profileBroadcastRef.current = queueProfileUpdate;
  }, [queueProfileUpdate]);

  useEffect(() => {
    const publishPrivacyChange = () => {
      const latest = useAppStore.getState().userProfile;

      if (!latest) return;
      void queueProfileUpdate(latest, false).catch((error) =>
        console.warn("[profile] privacy update failed", error)
      );
    };

    window.addEventListener(PRIVACY_PREFS_CHANGED_EVENT, publishPrivacyChange);

    return () => window.removeEventListener(PRIVACY_PREFS_CHANGED_EVENT, publishPrivacyChange);
  }, [queueProfileUpdate]);

  useEffect(() => {
    if (ui.mode !== "app" || !userProfile?.id) return;

    const publish = (includeAvatar: boolean) => {
      const latest = useAppStore.getState().userProfile;

      if (!latest) return;
      void queueProfileUpdate(latest, includeAvatar).catch((error) =>
        console.warn("[profile] presence heartbeat failed", error)
      );
    };

    publish(false);
    const interval = window.setInterval(() => publish(false), PRESENCE_HEARTBEAT_MS);

    return () => window.clearInterval(interval);
  }, [queueProfileUpdate, ui.mode, userProfile?.id]);

  const sendFriendRequestForFriend = useCallback(
    async (friend: UserProfile, traceId?: string, reconnect = false, capturedContext?: ReceiveContext) => {
      const context = capturedContext ?? await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      await context.vault.assertMain();
      const existing = friendRequestInFlightRef.current.get(friend.id);

      if (existing) {
        return existing;
      }

      const pending = (async () => {
        const effectiveTraceId = traceId ?? `friend-request:${friend.id}:${newClientBatchId()}`;
        let target = friend;

        try {
          target = await recoverAndPersistFriendRouting(friend, context);
        } catch (error) {
          console.warn("[friend] failed to recover routing hints from friendCode", error);
          return false;
        }

        const routingMeta = buildRoutingMeta(target);

        if (!routingMeta.toDeviceId) {
          return false;
        }

        const netConfig = useNetConfigStore.getState().config;
        const routeRequired = netConfig.mode === "onionRouter" || netConfig.onionEnabled;
        const hasRouteTarget = Boolean(routingMeta.route?.torOnion);

        if (routeRequired && !hasRouteTarget) {
          return false;
        }

        const conv = await ensureDirectConvForFriend(target, context);

        if (!conv) return false;

        if (!target.friendId || !target.identityPub || !target.dhPub) {
          return false;
        }

        const requestConversation = await savePendingFriendRequest(conv, target, context.vault);

        const payload = await buildFriendRequestPayload(
          requestConversation.id,
          effectiveTraceId,
          reconnect,
          context
        );

        if (!payload) return false;

        return sendFriendControlPacket(requestConversation, target, payload, context, "high");
      })();

      friendRequestInFlightRef.current.set(friend.id, pending);

      try {
        return await pending;
      } finally {
        if (friendRequestInFlightRef.current.get(friend.id) === pending) {
          friendRequestInFlightRef.current.delete(friend.id);
        }
      }
    },
    [
      buildFriendRequestPayload,
      buildRoutingMeta,
      ensureDirectConvForFriend,
      recoverAndPersistFriendRouting,
      sendFriendControlPacket,
    ]
  );

  useEffect(() => {
    const nextSeen: Record<string, string> = {};

    for (const friend of friends) {
      if (friend.friendStatus !== "request_out") continue;
      const routingMeta = buildResolvedRoutingMeta(friend);
      const hasDeviceId = Boolean(routingMeta.toDeviceId);
      const hasRouteTarget = Boolean(routingMeta.route?.torOnion);

      if (!hasDeviceId || (onionRouteRequired && !hasRouteTarget)) continue;

      const signature = [
        routingMeta.toDeviceId ?? "",
        routingMeta.route?.torOnion ?? "",
        friend.profileVcard?.friendCode ?? "",
      ].join("|");

      nextSeen[friend.id] = signature;

      if (friendRouteWakeSignatureRef.current[friend.id] === signature) continue;
      friendRouteWakeSignatureRef.current[friend.id] = signature;
      void (async () => {
        const attemptedAt = Date.now();

        try {
          const sent = await sendFriendRequestForFriend(friend);

          if (!sent) {
            await markFriendRequestReachability(friend.id, {
              status: "unreachable",
              lastAttemptAt: attemptedAt,
              lastError: "Send returned false (Routing or packet drop)",
            });

            return;
          }

          await markFriendRequestReachability(friend.id, {
            status: "ok",
            attempts: 0,
            lastAttemptAt: attemptedAt,
            nextAttemptAt: undefined,
            lastError: undefined,
          });
        } catch (error) {
          console.warn("[friend] immediate route-ready retry failed", error);
          await markFriendRequestReachability(friend.id, {
            status: "unreachable",
            lastAttemptAt: attemptedAt,
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    Object.keys(friendRouteWakeSignatureRef.current).forEach((friendId) => {
      if (!nextSeen[friendId]) {
        delete friendRouteWakeSignatureRef.current[friendId];
      }
    });
  }, [
    buildResolvedRoutingMeta,
    friends,
    markFriendRequestReachability,
    onionRouteRequired,
    sendFriendRequestForFriend,
  ]);

  const handleSendMessage = async (text: string, clientBatchId: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);

    if (!conv) return;

    const vk = getVaultKey();

    if (!vk) return;

    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;

    if (isDirect || conv.type === "group") {
      const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
      const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

      if (partner?.dhPub && partner.identityPub) {
        const now = Date.now();
        const messageId = createId();
        firstMessageMeasurement.userSend(messageId, conv.id);

        const context = await captureLocalOperationContext();

        if (context && await usesCertifiedDelivery(conv, partner, context)) {
          try {
            await sendAccountMessage(conv, partner, text, { id: messageId, clientBatchId, context });
          } catch (error) {
            console.warn("[sync] account message preparation failed", error instanceof Error ? error.message.match(/^[A-Z_]+$/)?.[0] ?? "UNCLASSIFIED" : "UNCLASSIFIED");
            notifyRoutePendingToast(conv.id, error instanceof Error ? error.message : "ACCOUNT_DELIVERY_PENDING");
          }

          await hydrateVault();

          return;
        }

        if (!isDirect) throw new Error("GROUP_ACCOUNT_AUTHORITY_REQUIRED");

        if (unifiedAppExperimentEnabled() && (!context || !await getAccountRootIdentity(context))) {
          try {
            await sendUnifiedAppText(conv, partner, { id: messageId, text, ts: now, senderId: userProfile.id });
          } catch {
            addToast({ message: "Experimental delivery remains pending or blocked; no legacy fallback was used." });
          }

          await hydrateVault();

          return;
        }

        await saveMessage({
          id: messageId,
          convId: conv.id,
          senderId: userProfile.id,
          text,
          ts: now,
          clientBatchId,
        });

        const updatedConv: Conversation = {
          ...conv,
          lastMessage: text,
          lastTs: now,
          unread: 0,
        };

        await saveConversation(updatedConv);
        await hydrateVault();
        void sendDirectEnvelope(
          conv,
          partner,
          { type: "msg", text, clientBatchId },
          "high",
          { eventId: messageId, releaseBeforeRoute: true }
        ).catch((error) => {
          console.error("Failed to route message", error);
          notifyRoutePendingToast(
            conv.id,
            error instanceof Error ? error.message : String(error)
          );
        });

        return;
      }
    }

    const message: Message = {
      id: createId(),
      convId: conv.id,
      senderId: userProfile.id,
      text,
      ts: Date.now(),
      clientBatchId,
    };

    if (isDirect) firstMessageMeasurement.userSend(message.id, conv.id);
    const ciphertext = await encryptJsonRecord(vk, message.id, "message", message);

    await saveMessage(message);

    const updatedConv: Conversation = {
      ...conv,
      lastMessage: text,
      lastTs: message.ts,
      unread: 0,
    };

    await saveConversation(updatedConv);
    await hydrateVault();
    void sendCiphertext({
      convId: conv.id,
      messageId: message.id,
      ciphertext,
      priority: "high",
    }).then((routed) => {
      if (!routed.ok) {
        console.error("Failed to route message", routed.error);
        notifyRoutePendingToast(conv.id, routed.error);
      }
    }).catch((error) => {
      console.error("Failed to route message", error);
      notifyRoutePendingToast(conv.id, error instanceof Error ? error.message : String(error));
    });
  };

  const handleSendMedia = async (files: File[], clientBatchId: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);

    if (!conv) return;

    const vk = getVaultKey();

    if (!vk) return;

    const initiatingGeneration = getAccountOwnerGeneration();
    const context = await captureLocalOperationContext();
    if (!context || initiatingGeneration !== getAccountOwnerGeneration()) throw new Error("OWNER_SESSION_CHANGED");
    const ownedProfiles = await listProfiles(context.vault);
    if (!ownedProfiles.some(profile => profile.kind === "user" && profile.id === userProfile.id)) throw new Error("OWNER_SESSION_CHANGED");
    context.vault.assertLocal();
    const recipientAccounts = [...new Set(ownedProfiles.filter(profile => profile.kind === "friend" &&
      conv.participants.includes(profile.id) && profile.identityPub).map(profile => profile.identityPub!))];
    const deferred = (error: unknown): boolean => error instanceof AggregateError
      ? error.errors.length > 0 && error.errors.every(deferred)
      : error instanceof Error && (error.message === "FRESH_SESSION_REQUIRED" || error.message.startsWith("RETRYABLE_SEND_FAILURE:"));

    const sendSingleMedia = async (file: File) => {
      context.vault.assertLocal();
      if (file.size > INLINE_MEDIA_MAX_BYTES) {
        emitFlowTraceLog({
          event: "mediaTransfer:send:rejected",
          level: "warn",
          source: "App.handleSendMedia",
          fileBytes: file.size,
          maxBytes: INLINE_MEDIA_MAX_BYTES,
          mime: file.type || "application/octet-stream",
          reason: "file-too-large",
        });
        addToast({ message: t("첨부파일이 너무 큽니다. 최대 500MB까지 보낼 수 있습니다.", "Attachment too large (max 500MB).") });

        return;
      }

      if (file.size >= SECONDARY_TOR_TRANSFER_THRESHOLD_BYTES) {
        const nkc = (
          globalThis as {
            nkc?: {
              ensureSecondaryTor?: (payload?: {
                bridgeMode?: "off" | "auto" | "force";
              }) => Promise<unknown>;
            };
          }
        ).nkc;

        void nkc?.ensureSecondaryTor?.({
          bridgeMode: useNetConfigStore.getState().config.torBridgeMode,
        }).catch((error) => {
          console.warn("[tor] secondary transfer lane preparation failed", error);
        });
      }

      const isDirect =
        !(conv.type === "group" || conv.participants.length > 2) &&
        conv.participants.length === 2;

      if (isDirect || conv.type === "group") {
        const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
        const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

        if (partner?.dhPub && partner.identityPub) {
          const partnerDhPub = partner.dhPub;
          const now = Date.now();
          const messageId = createId();
          const preparedMedia = await inspectOutgoingMediaFile(file);

          const media = createMessageMediaRef(
            messageId,
            file,
            INLINE_MEDIA_CHUNK_SIZE,
            preparedMedia
          );

          const label = media.mime.startsWith("image/") ? "Photo" : media.name || "File";

          context.vault.assertLocal();

          if (await usesCertifiedDelivery(conv, partner, context)) {
            await mediaTransferLanePoolRef.current.run(conv.id, async () => {
              context.vault.assertLocal();
              try { await sendAccountMessage(conv, partner, label, { id: messageId, media, clientBatchId, context }); }
              catch (error) { if (!deferred(error)) throw error; }
              await createMediaTransferProgress(messageId, conv.id, media.total, context.vault, recipientAccounts);
              await saveMessageMedia(messageId, file, INLINE_MEDIA_CHUNK_SIZE, undefined, preparedMedia, context.vault);
              await markMediaTransferStored(messageId, media.total - 1, context.vault);
              for await (const chunk of readMessageMediaChunks(media, context.vault)) {
                try { await sendAccountMediaChunk(conv, partner, messageId, chunk.idx, chunk.bytes, context); }
                catch (error) { if (!deferred(error)) throw error; }
              }
            });
            context.vault.assertLocal();
            await hydrateVault();

            return;
          }

          if (!isDirect) throw new Error("GROUP_ACCOUNT_AUTHORITY_REQUIRED");

          await saveMessage({
            id: messageId,
            convId: conv.id,
            senderId: userProfile.id,
            text: label,
            ts: now,
            media,
            clientBatchId,
          }, context.vault);

          await createMediaTransferProgress(messageId, conv.id, media.total, context.vault, recipientAccounts);

          const mediaStorage = saveMessageMedia(
            messageId,
            file,
            INLINE_MEDIA_CHUNK_SIZE,
            undefined,
            preparedMedia, context.vault
          );

          const updatedConv: Conversation = {
            ...conv,
            lastMessage: label,
            lastTs: now,
            unread: 0,
          };

          await saveConversation(updatedConv, context.vault);
          await hydrateVault();

          const sendTransfer = async () => {
            const operationContext = context;
            await mediaStorage;
            operationContext.vault.assertLocal();
            const transferStartedAt = Date.now();
            let completedChunks = 0;
            let completedBytes = 0;
            emitFlowTraceLog({
              event: "mediaTransfer:send:start",
              source: "App.handleSendMedia",
              operationId: messageId,
              fileBytes: file.size,
              mime: media.mime,
              chunkBytes: media.chunkSize,
              totalChunks: media.total,
            });
            await getSodium();
            const friendKeyId = partner.friendId ?? partner.id;
            const dhPriv = await getDhPrivateKey(operationContext);
            const pskBytes = await getFriendPsk(friendKeyId, operationContext);

            const keys = await deriveConversationKeyPair(
              dhPriv,
              decodeBase64Url(partnerDhPub),
              pskBytes,
              new TextEncoder().encode(`direct:${friendKeyId}`),
              new TextEncoder().encode(`conv:${conv.id}`)
            ).finally(() => {
              dhPriv.fill(0);
              pskBytes?.fill(0);
            });

            const cryptoContext = {
              ...keys,
              identityPrivateKey: await getIdentityPrivateKey(operationContext),
            };

            let cryptoPool: EnvelopeCryptoPool | null = null;
            let encryptor: typeof encryptEnvelope = encryptEnvelope;
            const transferWindow = new AdaptiveTransferWindow(media.total >= 2 ? 4 : 1, 2);
            const inFlight = new Set<Promise<void>>();
            let transferError: unknown = null;
            let deliveryConfirmation: ReturnType<typeof waitForMediaTransferCompletion> | null = null;

            try {
              await markMediaTransferStored(messageId, media.total - 1, operationContext.vault);

              try {
                cryptoPool = new EnvelopeCryptoPool(file.size >= 200 * 1024 * 1024 ? 2 : 1);
                await cryptoPool.prewarm();
                encryptor = (...args) => cryptoPool!.encrypt(...args);
              } catch (error) {
                cryptoPool?.close();
                cryptoPool = null;
                console.warn("[crypto] worker unavailable; using renderer fallback", error);
              }

              await sendDirectEnvelope(
                conv,
                partner,
                { type: "msg", text: label, media, clientBatchId },
                "normal",
                { eventId: messageId, context: operationContext, cryptoContext, encryptor, allowDeferred: true, releaseBeforeRoute: true }
              ).catch(error => { if (!deferred(error)) throw error; });
              emitFlowTraceLog({
                event: "mediaTransfer:send:manifest-sent",
                source: "App.handleSendMedia",
                operationId: messageId,
                elapsedMs: Date.now() - transferStartedAt,
                totalChunks: media.total,
                fileBytes: file.size,
              });

              for (let idx = 0; idx < media.total; idx += 1) {
                const bytes = new Uint8Array(
                  await file
                    .slice(idx * media.chunkSize, Math.min(file.size, (idx + 1) * media.chunkSize))
                    .arrayBuffer()
                );

                await markMediaTransferStored(messageId, idx, operationContext?.vault);

                if (transferError) break;
                const chunkBase64 = encodeBase64Url(bytes);

                const chunkBody = {
                  type: "media",
                  phase: "chunk",
                  ownerId: messageId,
                  idx,
                  total: media.total,
                  chunkSize: INLINE_MEDIA_CHUNK_SIZE,
                  mime: media.mime,
                  name: media.name,
                  size: media.size,
                  b64: chunkBase64,
                  clientBatchId,
                };

                const chunkStartedAt = Date.now();

                const task = sendDirectEnvelope(conv, partner, chunkBody, "normal", {
                  persistEvent: true,
                  eventId: `${messageId}:chunk:${idx}`,
                  context: operationContext,
                  cryptoContext,
                  encryptor,
                  // Ratchet and event ordering are committed before routing.
                  // Even a single-chunk photo must let other file lanes send.
                  releaseBeforeRoute: true,
                  outboxRetention: "standard",
                  transferId: messageId,
                  chunkIndex: idx,
                  binaryTransport: canUseBinaryMediaTransport(conv.id),
                  allowDeferred: true,
                })
                  .then(() => {
                    transferWindow.onSuccess();
                    completedChunks += 1;
                    completedBytes += bytes.byteLength;
                    const elapsedMs = Date.now() - transferStartedAt;
                    emitFlowTraceLog({
                      event: "mediaTransfer:send:chunk-sent",
                      source: "App.handleSendMedia",
                      operationId: messageId,
                      chunkIndex: idx,
                      totalChunks: media.total,
                      chunkBytes: bytes.byteLength,
                      chunkElapsedMs: Date.now() - chunkStartedAt,
                      completedChunks,
                      completedBytes,
                      elapsedMs,
                      throughputBytesPerSecond:
                        elapsedMs > 0 ? Math.round((completedBytes * 1000) / elapsedMs) : 0,
                      sendWindow: transferWindow.current,
                    });
                  })
                  .catch((error) => {
                    if (deferred(error)) return;
                    transferWindow.onFailure();
                    transferError ??= error;
                    emitFlowTraceLog({
                      event: "mediaTransfer:send:chunk-failed",
                      level: "error",
                      source: "App.handleSendMedia",
                      operationId: messageId,
                      chunkIndex: idx,
                      totalChunks: media.total,
                      chunkBytes: bytes.byteLength,
                      chunkElapsedMs: Date.now() - chunkStartedAt,
                      completedChunks,
                      completedBytes,
                      sendWindow: transferWindow.current,
                      errorDetail: toInfoLogErrorDetail(error),
                    });
                  });

                inFlight.add(task);
                void task.finally(() => inFlight.delete(task)).catch(() => {});

                if (inFlight.size >= transferWindow.current) await Promise.race(inFlight);

                if (idx > 0 && idx % 8 === 0) {
                  await new Promise<void>((resolve) => setTimeout(resolve, 0));
                }
              }

              await Promise.all(inFlight);
              await mediaStorage;

              if (transferError) throw transferError;
              const elapsedMs = Date.now() - transferStartedAt;
              emitFlowTraceLog({
                event: "mediaTransfer:send:complete",
                source: "App.handleSendMedia",
                operationId: messageId,
                fileBytes: file.size,
                totalChunks: media.total,
                completedChunks,
                completedBytes,
                elapsedMs,
                throughputBytesPerSecond:
                  elapsedMs > 0 ? Math.round((completedBytes * 1000) / elapsedMs) : 0,
                peerDeliveryConfirmed: false,
                completionStage: "local-handoff",
              });
              deliveryConfirmation = waitForMediaTransferCompletion(messageId, { access: operationContext?.vault });
            } catch (error) {
              emitFlowTraceLog({
                event: "mediaTransfer:send:failed",
                level: "error",
                source: "App.handleSendMedia",
                operationId: messageId,
                fileBytes: file.size,
                totalChunks: media.total,
                completedChunks,
                completedBytes,
                elapsedMs: Date.now() - transferStartedAt,
                errorDetail: toInfoLogErrorDetail(error),
              });
              throw error;
            } finally {
              await Promise.allSettled(inFlight);
              cryptoPool?.close();
              cryptoContext.conversationKey.fill(0);
              cryptoContext.ratchetBaseKey.fill(0);
              cryptoContext.identityPrivateKey.fill(0);
            }

            // Release the sending lane before waiting for the recipient's ACK.
            return { deliveryConfirmation };
          };

          void mediaTransferLanePoolRef.current.run(conv.id, sendTransfer).then(async ({ deliveryConfirmation }) => {
            if (deliveryConfirmation) {
              try {
                const progress = await deliveryConfirmation;
                emitFlowTraceLog({
                  event:
                    progress?.status === "complete"
                      ? "mediaTransfer:send:delivered"
                      : "mediaTransfer:send:ack-timeout",
                  level: progress?.status === "complete" ? "info" : "warn",
                  source: "App.handleSendMedia",
                  operationId: messageId,
                  fileBytes: file.size,
                  totalChunks: media.total,
                  ackedThrough: progress?.ackedThrough ?? -1,
                  peerDeliveryConfirmed: progress?.status === "complete",
                });
              } catch (error) {
                console.warn("Failed to observe media delivery ACK", error);
              }
            }
          }).catch((error) => {
            console.error("Failed to send media chunks", error);
          });

          return;
        }
      }

      const messageId = createId();
      const preparedMedia = await inspectOutgoingMediaFile(file);
      const media = createMessageMediaRef(messageId, file, undefined, preparedMedia);
      const label = media.mime.startsWith("image/") ? "Photo" : media.name || "File";

      const message: Message = {
        id: messageId,
        convId: conv.id,
        senderId: userProfile.id,
        text: label,
        ts: Date.now(),
        media,
        clientBatchId,
      };

      const ciphertext = await encryptJsonRecord(vk, message.id, "message", message);

      await saveMessage(message, context.vault);
      await saveMessageMedia(messageId, file, undefined, undefined, preparedMedia, context.vault);

      const updatedConv: Conversation = {
        ...conv,
        lastMessage: label,
        lastTs: message.ts,
        unread: 0,
      };

      await saveConversation(updatedConv);
      await hydrateVault();

      void sendCiphertext({
        convId: conv.id,
        messageId: message.id,
        ciphertext,
        priority: "high",
      }).catch((error) => {
        console.error("Failed to route message", error);
      });

    };

    for (const file of files) {
      try {
        await sendSingleMedia(file);
      } catch (error) {
        console.error("Failed to send media", error);
        emitFlowTraceLog({
          event: "mediaTransfer:send:prepare-failed",
          level: "error",
          source: "App.handleSendMedia",
          fileBytes: file.size,
          mime: file.type || "application/octet-stream",
          errorDetail: toInfoLogErrorDetail(error),
        });
        addToast({ message: t("첨부파일을 보내지 못했습니다. 다시 시도해 주세요.", "Failed to send attachment.") });
      }
    }
  };

  const handleSendBatch = async (payload: { text: string; files: File[] }) => {
    const conversationId = ui.selectedConvId;

    if (!conversationId) return;
    const trimmed = payload.text.trim();
    const hasText = Boolean(trimmed);
    const hasFiles = payload.files.length > 0;

    if (!hasText && !hasFiles) return;

    if (sendBatchInFlightRef.current.has(conversationId)) {
      console.warn("[sync] account message composer busy");

      return;
    }

    sendBatchInFlightRef.current.add(conversationId);

    try {
      const clientBatchId = newClientBatchId();

      if (hasText) {
        await handleSendMessage(trimmed, clientBatchId);
      }

      if (hasFiles) {
        // File inspection/storage must not lock the composer for subsequent chat.
        // This invocation captures the current conversation and batch identity.
        void handleSendMedia(payload.files, clientBatchId).catch((error) => {
          console.error("Failed to prepare media batch", error);
          addToast({ message: t("첨부파일을 보내지 못했습니다. 다시 시도해 주세요.", "Failed to send attachment.") });
        });
      }
    } finally {
      sendBatchInFlightRef.current.delete(conversationId);
    }
  };

  const handleDeleteMessages = useCallback(
    (payload: { convId: string; messageIds: string[] }) => {
      if (!payload.messageIds.length) return;
      setConfirm({
        title: t("메시지 삭제", "Delete message"),
        message:
          t("이 메시지는 내 기기에서만 삭제됩니다. 삭제 후 복구할 수 없습니다. 계속할까요?", "This message will be deleted only on this device and cannot be recovered. Continue?"),
        onConfirm: async () => {
          try {
            await deleteMessagesById(payload.messageIds);
            const messageIdSet = new Set(payload.messageIds);
            const currentMessagesByConv = useAppStore.getState().messagesByConv;
            const existing = currentMessagesByConv[payload.convId] || [];
            const remaining = existing.filter((msg) => !messageIdSet.has(msg.id));

            const updatedMessagesByConv = {
              ...currentMessagesByConv,
              [payload.convId]: remaining,
            };

            let updatedConvs = convs;
            const conv = convs.find((item) => item.id === payload.convId);

            if (conv) {
              const last = remaining[remaining.length - 1];

              const lastMessage = last
                ? last.text?.trim()
                  ? last.text
                  : last.media
                    ? last.media.mime.startsWith("image/")
                      ? "사진"
                      : last.media.name || "파일"
                    : ""
                : "";

              const lastTs = last?.ts ?? 0;

              if (lastMessage !== conv.lastMessage || lastTs !== conv.lastTs) {
                const updatedConv: Conversation = {
                  ...conv,
                  lastMessage,
                  lastTs,
                };

                await saveConversation(updatedConv);
                updatedConvs = convs.map((item) =>
                  item.id === updatedConv.id ? updatedConv : item
                );
              }
            }

            setData({
              user: userProfile,
              friends,
              convs: updatedConvs,
              messagesByConv: updatedMessagesByConv,
            });
            window.dispatchEvent(
              new CustomEvent("nkc:messages-updated", {
                detail: { convId: payload.convId },
              })
            );
            addToast({ message: t("메시지를 삭제했습니다.", "Message deleted.") });
          } catch (error) {
            console.error("Failed to delete message", error);
            addToast({ message: t("메시지 삭제에 실패했습니다.", "Could not delete the message.") });
          }
        },
      });
    },
    [addToast, convs, friends, setConfirm, setData, userProfile]
  );

  const findDirectConvWithFriend = useCallback(
    (friendId: string) =>
      convs.find(
        (conv) =>
          !(conv.type === "group" || conv.participants.length > 2) &&
          conv.participants.includes(friendId)
      ),
    [convs]
  );

  const handleSendReadReceipt = useCallback(
    async (payload: { convId: string; msgId: string; msgTs: number }) => {
      if (!userProfile) return;
      const conv = convs.find((item) => item.id === payload.convId);

      if (!conv) return;
      const cursorTs = payload.msgTs;
      const context = await captureLocalOperationContext();
      await putReadCursor({
        convId: conv.id,
        actorId: userProfile.id,
        cursorTs,
        anchorMsgId: payload.msgId,
      }, context?.vault);

      const sendNow = async (targetConv: Conversation, targetCursorTs: number, anchorMsgId: string) => {
        lastReadCursorSentAtRef.current[targetConv.id] = Date.now();
        lastReadCursorSentTsRef.current[targetConv.id] = targetCursorTs;

        if (targetConv.type === "group" && context && await getAccountRootIdentity(context)) {
          const anchor = await getStoredMessage(anchorMsgId, context.vault);

          if (anchor && anchor.convId !== targetConv.id) throw new Error("READ_ACTOR_MISMATCH");
          const partner = friends.find(friend => friend.identityPub === anchor?.logicalProof?.senderAccountIdentity);

          if (!partner) throw new Error("READ_ACTOR_MISMATCH");
          await sendAccountRead(targetConv, partner, anchorMsgId, context);

          return;
        }

        const isDirect =
          !(targetConv.type === "group" || targetConv.participants.length > 2) &&
          targetConv.participants.length === 2;

        if (isDirect) {
          const partnerId =
            targetConv.participants.find((id) => id && id !== userProfile.id) || null;

          const partner = partnerId
            ? friends.find((friend) => friend.id === partnerId) || null
            : null;

          if (!partner?.dhPub || !partner.identityPub) return;

          try {
            if (context && await usesCertifiedDelivery(targetConv, partner, context)) {
              await sendAccountRead(targetConv, partner, anchorMsgId, context);

              return;
            }

            await sendDirectEnvelope(
              targetConv,
              partner,
              {
                type: "rcpt",
                kind: "read_cursor",
                convId: targetConv.id,
                cursorTs: targetCursorTs,
                anchorMsgId,
                ts: Date.now(),
              },
              "normal"
            );
          } catch (error) {
            console.error("Failed to send read cursor", error);
          }

          return;
        }

        const targets = targetConv.participants.filter((id) => id && id !== userProfile.id);

        for (const memberId of targets) {
          const friend = friends.find((item) => item.id === memberId);

          if (!friend?.dhPub || !friend.identityPub) continue;
          const directConv = findDirectConvWithFriend(friend.id);

          if (!directConv) continue;

          try {
            await sendDirectEnvelope(
              directConv,
              friend,
              {
                type: "rcpt",
                kind: "read_cursor",
                convId: targetConv.id,
                cursorTs: targetCursorTs,
                anchorMsgId,
                ts: Date.now(),
              },
              "normal"
            );
          } catch (error) {
            console.error("Failed to send group read cursor", { memberId }, error);
          }
        }
      };

      const lastCursorTs = lastReadCursorSentTsRef.current[conv.id] ?? 0;

      if (cursorTs <= lastCursorTs) return;

      const now = Date.now();
      const lastSentAt = lastReadCursorSentAtRef.current[conv.id] ?? 0;
      const elapsed = now - lastSentAt;

      if (elapsed < READ_CURSOR_THROTTLE_MS) {
        const pending = pendingReadCursorRef.current[conv.id];

        if (!pending || cursorTs > pending.cursorTs) {
          pendingReadCursorRef.current[conv.id] = { cursorTs, anchorMsgId: payload.msgId };
        }

        if (!readCursorThrottleTimerRef.current[conv.id]) {
          const waitMs = Math.max(READ_CURSOR_THROTTLE_MS - elapsed, 0);
          readCursorThrottleTimerRef.current[conv.id] = window.setTimeout(() => {
            readCursorThrottleTimerRef.current[conv.id] = undefined;
            const next = pendingReadCursorRef.current[conv.id];

            if (!next) return;
            const latestConv = convs.find((item) => item.id === conv.id);

            if (!latestConv) return;
            const sentTs = lastReadCursorSentTsRef.current[conv.id] ?? 0;

            if (next.cursorTs <= sentTs) {
              pendingReadCursorRef.current[conv.id] = undefined;

              return;
            }

            pendingReadCursorRef.current[conv.id] = undefined;
            void sendNow(latestConv, next.cursorTs, next.anchorMsgId);
          }, waitMs);
        }

        return;
      }

      pendingReadCursorRef.current[conv.id] = undefined;
      void sendNow(conv, cursorTs, payload.msgId);
    },
    [convs, findDirectConvWithFriend, friends, sendDirectEnvelope, userProfile]
  );

  const ensureDirectConvForFanout = useCallback(
    async (friend: UserProfile, ts: number, context?: ReceiveContext) => {
      context?.vault.assertLocal();

      if (!userProfile) return null;
      const existing = findDirectConvWithFriend(friend.id);

      if (existing) return existing;

      const directConv: Conversation = {
        id: createId(),
        type: "direct",
        name: friend.displayName || "Direct channel",
        pinned: false,
        unread: 0,
        hidden: true,
        muted: false,
        blocked: false,
        lastTs: ts,
        lastMessage: "",
        participants: [userProfile.id, friend.id],
      };

      await saveConversation(directConv, context?.vault);

      return directConv;
    },
    [findDirectConvWithFriend, userProfile]
  );

  const fanoutGroupAvatarChunks = useCallback(
    async (
      groupId: string,
      sharedAvatarRef: string | undefined,
      memberIds: string[],
      options?: { allowCreateDirect?: boolean; context?: ReceiveContext }
    ) => {
      if (!userProfile || !sharedAvatarRef) return;
      const context = options?.context ?? await captureLocalOperationContext();

      if (!context) throw new Error("GROUP_OWNER_REQUIRED");
      context.vault.assertLocal();
      const avatar = parseAvatarRef(sharedAvatarRef);

      if (!avatar?.revision || avatar.ownerType !== "group" || avatar.ownerId !== groupId) throw new Error("GROUP_AVATAR_MANIFEST_REQUIRED");
      const actorIdentity = encodeBase64Url(await getIdentityPublicKey(context));
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const blob = await loadAvatarFromRef(sharedAvatarRef, context.vault);

      if (!blob) return;

      const buffer = await blob.arrayBuffer();
      const chunks = chunkBuffer(buffer, INLINE_MEDIA_CHUNK_SIZE);
      const total = chunks.length;

      if (!total) return;

      const targets = Array.from(new Set(memberIds)).filter(
        (id) => id && id !== userProfile.id
      );

      for (const memberId of targets) {
        context.vault.assertLocal();
        const friend = friends.find((item) => item.id === memberId);

        if (!friend?.dhPub || !friend.identityPub) continue;
        let directConv = findDirectConvWithFriend(memberId) || null;

        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, Date.now(), context);
        }

        if (!directConv) continue;

        const sendChunks = async () => {
          for (let idx = 0; idx < chunks.length; idx += 1) {
            await sendDirectEnvelope(
              directConv,
              friend,
              {
                type: "media",
                phase: "chunk",
                ownerType: "group",
                v: 2, identityKind: "ed25519", actorIdentity, revision: avatar.revision,
                ownerId: groupId,
                idx,
                total,
                chunkSize: INLINE_MEDIA_CHUNK_SIZE, size: blob.size,
                mime: blob.type || "image/png",
                b64: encodeBase64Url(chunks[idx]),
              },
              "normal", { context }
            );

            if (idx > 0 && idx % 32 === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          }
        };

        void sendChunks().catch((error) => {
          console.error("Failed to fanout group avatar chunks", { memberId }, error);
        });
      }
    },
    [
      ensureDirectConvForFanout,
      findDirectConvWithFriend,
      friends,
      sendDirectEnvelope,
      userProfile,
    ]
  );

  const fanoutGroupEvent = useCallback(
    async (
      memberIds: string[],
      event: GroupEventPayload,
      options?: { allowCreateDirect?: boolean; toastOnFailure?: boolean; sendAvatarChunks?: boolean; queueOnly?: boolean }
    ) => {
      if (!userProfile) return;
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const toastOnFailure = options?.toastOnFailure ?? true;
      const sendAvatarChunks = options?.sendAvatarChunks ?? true;
      const context = await captureLocalOperationContext();

      if (!context) throw new Error("GROUP_OWNER_REQUIRED");
      const wire = await encodeGroupEvent(event, context);
      const root = await getAccountRootIdentity(context);
      const eventIdentity = root ? `group:${encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(wire)))}` : undefined;
      const targets = Array.from(new Set(memberIds)).filter((id) => id && id !== userProfile.id);

      if (!targets.length) return;

      const failures: string[] = [];

      for (const memberId of targets) {
        context.vault.assertLocal();
        const friend = friends.find((item) => item.id === memberId);

        if (!friend?.dhPub || !friend.identityPub) {
          failures.push(memberId);
          continue;
        }

        let directConv = findDirectConvWithFriend(memberId) || null;

        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, event.ts, context);
        }

        if (!directConv) {
          failures.push(memberId);
          continue;
        }

        try {
          if (root) {
            const recipient = Object.values(await getAuthorizedDeviceRegistry(context, friend.identityPub));

            if (!recipient.some(device => device.kind === "DEVICE_ADDED")) throw new Error("RECIPIENT_DEVICES_UNKNOWN");
            const devices = [...recipient, ...Object.values(await getAuthorizedDeviceRegistry(context))];

            for (const deviceTarget of devices) {
              if (deviceTarget.kind !== "DEVICE_ADDED" || deviceTarget.deviceId === getOrCreateDeviceId(context)) continue;
              await sendDirectEnvelope(directConv, friend, wire, "normal", { context, deviceTarget,
                eventId: await deviceDeliveryIdentity(eventIdentity!, deviceTarget, getOrCreateDeviceId(context)),
                reuseEvent: true, v2Only: true, allowDeferred: true, queueOnly: options?.queueOnly });
            }
          } else await sendDirectEnvelope(directConv, friend, wire, "normal", { context, queueOnly: options?.queueOnly });
        } catch (error) {
          console.error("Failed to fanout group event", { memberId }, error);
          failures.push(memberId);
        }
      }

      if (failures.length && toastOnFailure) {
        addToast({ message: `Some members could not be notified (${failures.length}).` });
      }

      if (event.kind === "group.create" && event.sharedAvatarRef && sendAvatarChunks) {
        await fanoutGroupAvatarChunks(event.id, event.sharedAvatarRef, targets, {
          allowCreateDirect, context,
        });
      }

      return failures.length;
    },
    [
      addToast,
      ensureDirectConvForFanout,
      fanoutGroupAvatarChunks,
      findDirectConvWithFriend,
      friends,
      sendDirectEnvelope,
      userProfile,
    ]
  );

  const handleSelectFriend = async (friendId: string) => {
    const existing = findDirectConvWithFriend(friendId);

    if (existing) {
      setSelectedConv(existing.id);
      setMode("app");

      return;
    }

    if (!userProfile) return;

    const friend = friends.find((item) => item.id === friendId);

    const now = Date.now();

    const newConv: Conversation = {
      id: createId(),
      type: "direct",
      name: friend?.displayName || "새 채팅",
      pinned: friend?.isFavorite ?? false,
      unread: 0,
      hidden: false,
      muted: false,
      blocked: false,
      pendingOutgoing: friend?.friendStatus === "request_out",
      lastTs: now,
      lastMessage: "채팅을 시작했어요.",
      participants: [userProfile.id, friendId],
    };

    await saveConversation(newConv);

    await saveMessage({
      id: createId(),
      convId: newConv.id,
      senderId: "system",
      text: "채팅을 시작했어요.",
      ts: now,
    });

    await hydrateVault();
    setSelectedConv(newConv.id);
  };

  const updateConversation = async (convId: string, updates: Partial<Conversation>) => {
    const target = convs.find((conv) => conv.id === convId);

    if (!target) return;
    const updated = { ...target, ...updates };
    await saveConversation(updated);
    await hydrateVault();
  };


  const handleSelectConv = (convId: string) => {
    setSelectedConv(convId);
    const target = convs.find((conv) => conv.id === convId);

    if (target && target.unread > 0) {
      void updateConversation(convId, { unread: 0 });
    }
  };

  const handleHide = (convId: string) => {
    void updateConversation(convId, { hidden: true });
    addToast({
      message: t("채팅을 숨겼어요.", "Chat hidden."),
      actionLabel: t("되돌리기", "Undo"),
      onAction: () => {
        void updateConversation(convId, { hidden: false });
      },
    });
  };

  const handleDelete = (convId: string) => {
    setConfirm({
      title: t("채팅을 삭제할까요?", "Delete this chat?"),
      message: t("삭제하면 복구할 수 없습니다.", "Deleted data cannot be recovered."),
      onConfirm: async () => {
        await deleteConversationData(convId);
        await hydrateVault();

        if (ui.selectedConvId === convId) {
          setSelectedConv(null);
          setRightPanelOpen(false);
        }

        addToast({ message: t("채팅과 대화 내역을 삭제했습니다.", "Chat and history deleted.") });
      },
    });
  };

  const handleTogglePin = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);

    if (!target) return;
    void updateConversation(convId, { pinned: !target.pinned });
  };

  const handleMute = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);

    if (!target) return;
    void updateConversation(convId, { muted: !target.muted });
  };

  const handleBlock = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);

    if (!target) return;
    void updateConversation(convId, { blocked: !target.blocked });
  };

  const handleFriendChat = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
      setListFilter("all");
    } catch (error) {
      console.error("Failed to open chat", error);
      addToast({ message: t("채팅 열기에 실패했습니다.", "Could not open the chat.") });
    }
  };

  const handleFriendViewProfile = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
      setListFilter("all");
      setRightTab("about");
      setRightPanelOpen(true);
    } catch (error) {
      console.error("Failed to open profile", error);
      addToast({ message: t("프로필 열기에 실패했습니다.", "Could not open the profile.") });
    }
  };

  const updateFriend = async (friendId: string, updates: Partial<UserProfile>) => {
    const target = friends.find((friend) => friend.id === friendId);

    if (!target) return;

    const updated: UserProfile = {
      ...target,
      ...updates,
      updatedAt: Date.now(),
    };

    try {
      await saveProfile(updated);
      await hydrateVault();
    } catch (error) {
      console.error("Failed to update friend", error);
      addToast({ message: t("친구 변경에 실패했습니다.", "Could not update the friend.") });
    }
  };


  const handleFriendToggleFavorite = async (friendId: string) => {
    const target = friends.find((friend) => friend.id === friendId);

    if (!target) return;

    const nextFavorite = !target.isFavorite;

    try {
      await updateFriend(friendId, { isFavorite: nextFavorite });
      const existing = findDirectConvWithFriend(friendId);

      if (existing) {
        await updateConversation(existing.id, { pinned: nextFavorite });
      }
    } catch (error) {
      console.error("Failed to toggle favorite", error);
      addToast({ message: t("즐겨찾기 변경에 실패했습니다.", "Could not update favorites.") });
    }
  };

  const handleFriendHide = (friendId: string) => {
    setConfirm({
      title: t("친구를 숨길까요?", "Hide this friend?"),
      message: t("숨긴 친구는 친구 관리에서 다시 표시할 수 있습니다.", "Hidden friends can be restored later from friend management."),
      onConfirm: async () => {
        await updateFriend(friendId, { friendStatus: "hidden" });
        const existing = findDirectConvWithFriend(friendId);

        if (existing) {
          await updateConversation(existing.id, { hidden: true });
        }
      },
    });
  };

  const handleFriendBlock = (friendId: string) => {
    setConfirm({
      title: t("친구를 차단할까요?", "Block this friend?"),
      message: t("차단하면 이 친구의 대화가 숨겨집니다.", "Blocking will hide their conversations."),
      onConfirm: async () => {
        try {
          await updateFriend(friendId, { friendStatus: "blocked" });
          const existing = findDirectConvWithFriend(friendId);

          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true, pendingFriendResponse: undefined });
          }
        } catch (error) {
          console.error("Failed to block friend", error);
          addToast({ message: t("친구를 차단하지 못했습니다.", "Failed to block friend.") });
        }
      },
    });
  };

  const handleFriendUnhide = async (friendId: string) => {
    await updateFriend(friendId, { friendStatus: "normal" });
  };

  const handleFriendUnblock = async (friendId: string) => {
    try {
      await updateFriend(friendId, { friendStatus: "normal" });
      const existing = findDirectConvWithFriend(friendId);

      if (existing) {
        await updateConversation(existing.id, { blocked: false, hidden: false });
      }
    } catch (error) {
      console.error("Failed to unblock friend", error);
      addToast({ message: t("친구 차단을 해제하지 못했습니다.", "Failed to unblock friend.") });
    }
  };

  const handleFriendDelete = (friendId: string) => {
    const target = friends.find((friend) => friend.id === friendId);
    const accountId = getActiveAccountId(), generation = getAccountOwnerGeneration();

    if (!target) return;
    setConfirm({
      title: t("친구를 삭제할까요?", "Delete this friend?"),
      message: t("친구 목록에서 삭제합니다. 나중에 다시 추가할 수 있습니다.", "This removes the friend from your list. You can re-add them later."),
      onConfirm: async () => {
        try {
          if (getActiveAccountId() !== accountId || getAccountOwnerGeneration() !== generation) throw new Error("OWNER_SESSION_CHANGED");
          const context = await captureLocalOperationContext();
          if (!context) throw new Error("OWNER_REQUIRED");
          if (getActiveAccountId() !== accountId || getAccountOwnerGeneration() !== generation) throw new Error("OWNER_SESSION_CHANGED");
          const current = (await listProfiles(context.vault)).find(profile => profile.id === friendId);
          if (!current || JSON.stringify(current) !== JSON.stringify(target)) throw new Error("PROFILE_APPLICATION_CONFLICT");
          const directConversations = (await listConversations(context.vault)).filter(
            (conv) =>
              !(conv.type === "group" || conv.participants.length > 2) &&
              conv.participants.includes(friendId)
          );

          for (const conversation of directConversations) {
            await deleteConversationData(conversation.id, context.vault);
          }

          const pskKeyId = target.friendId ?? target.id;
          await clearFriendPsk(pskKeyId, context);
          await saveProfile({
            ...target,
            friendStatus: "deleted",
            isFavorite: false,
            pskHint: false,
            updatedAt: Date.now(),
          }, context.vault, current);
          await hydrateVault();
          context.vault.assertLocal();

          if (directConversations.some((conv) => conv.id === ui.selectedConvId)) {
            setSelectedConv(null);
            setRightPanelOpen(false);
          }
        } catch (error) {
          console.error("Failed to delete friend", error);
          addToast({ message: t("친구를 삭제하지 못했습니다.", "Failed to delete friend.") });
        }
      },
    });
  };

  const handleCopyFriendCode = async () => {
    try {
      const runtimeSnapshot = await resolveRuntimeNetworkSnapshot();
      const payload = await buildLocalFriendCodePayload();

      const friendCode = isTorFriendCodeReady(runtimeSnapshot, payload)
        ? encodeFriendCodeV1({ v: 1, ...payload })
        : "";

      if (!friendCode) {
        addToast({ message: t("친구 코드가 아직 준비되지 않았습니다.", "Your friend code is not ready yet.") });

        return;
      }

      setMyFriendCode(friendCode);
      await navigator.clipboard.writeText(friendCode);
      const decoded = decodeFriendCodeV1(friendCode);
      const hasRouteTarget = !("error" in decoded) && Boolean(decoded.onionAddr);
      addToast({
        message: hasRouteTarget
          ? t("친구 코드가 복사되었습니다.", "Friend code copied.")
          : t("친구 코드는 복사되었지만 onion 주소가 없어 상대가 먼저 연결하지 못할 수 있습니다. Tor 연결 후 다시 복사해 주세요.", "Code copied without an Onion address. Your friend may not be able to connect first. Connect Tor, then copy again."),
      });
    } catch (error) {
      console.error("Failed to copy friend code", error);
      addToast({ message: t("친구 코드 복사에 실패했습니다.", "Could not copy the friend code.") });
    }
  };

  const handleResolveFriendRoute = useCallback(async () => {
    if (routeResolveBusy) return;
    const operationId = `friend-route-resolve:${newClientBatchId()}`;
    const startedAt = nowMonotonicMs();
    const elapsedMs = () => Math.max(0, Math.round(nowMonotonicMs() - startedAt));

    const baseContext = {
      mode: netConfig.mode,
      onionEnabled: netConfig.onionEnabled,
      onionSelectedNetwork: netConfig.onionSelectedNetwork,
      torStatus: netConfig.tor.status,
    };

    const runtimeBootstrap: RuntimeBootstrapDiagnostics = {};
    emitRouterTestLog({
      status: "attempt",
      stage: "friend-route-resolve:start",
      source: "app:handleResolveFriendRoute",
      operationId,
      elapsedMs: 0,
      context: baseContext,
    });
    setRouteResolveBusy(true);

    try {
      const nkc = (
        globalThis as {
          nkc?: {
            startTor?: () => Promise<unknown>;
            ensureHiddenService?: () => Promise<unknown>;
          };
        }
      ).nkc;

      if (nkc) {
        if (netConfig.onionSelectedNetwork === "tor") {
          try {
            const torRuntime = TorRuntime.getInstance();
            await torRuntime.start({ timeoutMs: 15_000 });
            await torRuntime.awaitReady(15_000);
            runtimeBootstrap.torRuntimeState = torRuntime.getState();
            runtimeBootstrap.torDataDir = torRuntime.getDataDir();
          } catch (error) {
            runtimeBootstrap.torStartError = error instanceof Error ? error.message : String(error);
          }
        }

        if (nkc.ensureHiddenService) {
          try {
            await nkc.ensureHiddenService();
          } catch (error) {
            runtimeBootstrap.hiddenServiceError =
              error instanceof Error ? error.message : String(error);
          }
        }
      }

      const warmupConfig = {
        ...netConfig,
        mode: "onionRouter" as const,
        onionEnabled: true,
      };

      const warmup = await prewarmRouter({
        config: warmupConfig,
        includeFallback: true,
      });

      let refreshed = "";
      let hasRouteTarget = false;
      let refreshAttempts = 0;
      setMyFriendCode("");

      for (const delayMs of [0, 700, 1400]) {
        if (delayMs > 0) {
          await waitMs(delayMs);
        }

        refreshAttempts += 1;
        const payload = await buildLocalFriendCodePayload();
        const candidateRuntime = await resolveRuntimeNetworkSnapshot();

        if (!isTorFriendCodeReady(candidateRuntime, payload)) {
          setMyFriendCode("");
          continue;
        }

        refreshed = encodeFriendCodeV1({ v: 1, ...payload });
        setMyFriendCode(refreshed);
        const decoded = decodeFriendCodeV1(refreshed);
        hasRouteTarget = !("error" in decoded) && Boolean(decoded.onionAddr);

        if (hasRouteTarget) break;
      }

      const routerOpened = warmup.started.includes("onionRouter");
      const runtimeSnapshot = await resolveRuntimeNetworkSnapshot();
      setFriendCodeRuntimeSnapshot((prev) =>
        sameRuntimeNetworkSnapshot(prev, runtimeSnapshot) ? prev : runtimeSnapshot
      );
      const resolved = hasRouteTarget && routerOpened && runtimeSnapshot.torState === "running";

      if (!resolved) {
        setMyFriendCode("");
      }

      emitRouterTestLog({
        status: resolved ? "ready" : "failed",
        stage: "friend-route-resolve:result",
        source: "app:handleResolveFriendRoute",
        operationId,
        elapsedMs: elapsedMs(),
        message: resolved
          ? "Friend route resolve completed with onion route target"
          : "Friend route resolve completed without stable router/route target",
        error: resolved
          ? undefined
          : `hasRouteTarget:${String(hasRouteTarget)}|routerOpened:${String(routerOpened)}`,
        context: {
          ...baseContext,
          runtimeBootstrap,
          chosenTransport: warmup.chosenTransport,
          requestedTransports: warmup.requested,
          startedTransports: warmup.started,
          failedTransports: warmup.failed,
          hasRouteTarget,
          routerOpened,
          refreshAttempts,
          friendCodeLength: refreshed.length,
          runtimeSnapshot,
        },
      });
      addToast({
        message: hasRouteTarget && routerOpened
          ? t("경로 정보를 찾았습니다. 코드를 다시 복사해 전달해 주세요.", "Route found. Copy the code again and share it.")
          : hasRouteTarget
            ? t("코드 경로 정보는 준비됐지만 라우터 초기화가 지연됩니다. 잠시 후 다시 시도해 주세요.", "Code route ready; router startup is delayed. Try again shortly.")
            : t("아직 경로 정보를 찾지 못했습니다. 잠시 후 다시 시도하거나 상대가 먼저 친구 추가하도록 안내해 주세요.", "No route found yet. Try again shortly or ask your friend to add you first."),
      });
    } catch (error) {
      emitRouterTestLog({
        status: "failed",
        stage: "friend-route-resolve:exception",
        source: "app:handleResolveFriendRoute",
        operationId,
        elapsedMs: elapsedMs(),
        error: error instanceof Error ? error.message : String(error),
        errorDetail: toInfoLogErrorDetail(error),
        context: {
          ...baseContext,
          runtimeBootstrap,
        },
      });
      console.error("Failed to resolve friend route", error);
      addToast({ message: t("경로 확인에 실패했습니다.", "Could not check the route.") });
    } finally {
      setRouteResolveBusy(false);
    }
  }, [
    addToast,
    buildLocalFriendCodePayload,
    emitRouterTestLog,
    netConfig,
    resolveRuntimeNetworkSnapshot,
    routeResolveBusy,
  ]);

  const normalizeInviteCode = (value: string) => {
    let next = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    next = next.replace(/^[\s"'`([{<]+/, "");
    next = next.replace(/[\s"'`)\]}>:;,.!?]+$/, "");

    return next.replace(/\s+/g, "").toUpperCase();
  };

  const computeInviteFingerprint = async (normalized: string) => {
    if (!globalThis.crypto?.subtle) {
      const fallback = sha256(new TextEncoder().encode(normalized));

      return encodeBase64Url(fallback).slice(0, 22);
    }

    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized)
    );

    return encodeBase64Url(new Uint8Array(digest)).slice(0, 22);
  };


  const handleCreateGroup = () => {
    setGroupCreateOpen(true);
  };

  const handleInviteToGroup = (convId: string) => {
    setGroupInviteConvId(convId);
    setGroupInviteOpen(true);
    setRightTab("about");
    setRightPanelOpen(true);
  };

  const handleSubmitGroupInvite = async (convId: string, memberIds: string[]) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };
    const conv = convs.find((item) => item.id === convId);

    if (!conv || (conv.type !== "group" && conv.participants.length <= 2)) {
      return { ok: false as const, error: "Group not found." };
    }

    const prevParticipants = conv.participants;

    const newMembers = Array.from(new Set(memberIds)).filter(
      (id) => id && id !== userProfile.id && !prevParticipants.includes(id)
    );

    if (!newMembers.length) {
      return { ok: false as const, error: "Select at least one new member." };
    }

    try {
      const now = Date.now();
      const nextParticipants = Array.from(new Set([...prevParticipants, ...newMembers]));

      const updated: Conversation = {
        ...conv,
        participants: nextParticipants,
        hidden: false,
        lastTs: now,
        lastMessage: "Members invited",
      };

      await saveConversation(updated);

      const inviteEvent = buildGroupInviteEvent({
        groupId: conv.id,
        memberIds: newMembers,
        actorId: userProfile.id,
        ts: now,
      });

      const existingRecipients = prevParticipants.filter((id) => id && id !== userProfile.id);
      await fanoutGroupEvent(existingRecipients, inviteEvent);

      const createEvent = await syncGroupCreate({
        id: conv.id,
        name: conv.name,
        memberIds: nextParticipants,
        actorId: userProfile.id,
        ts: now,
        sharedAvatarRef: conv.sharedAvatarRef,
      });

      await fanoutGroupEvent(newMembers, createEvent, {
        allowCreateDirect: true,
        toastOnFailure: false,
      });

      await hydrateVault();

      return { ok: true as const };
    } catch (error) {
      console.error("Failed to invite group members", error);

      return { ok: false as const, error: "Failed to invite members." };
    }
  };

  const handleLeaveGroup = (convId: string) => {
    if (!userProfile) return;
    const conv = convs.find((item) => item.id === convId);

    if (!conv || (conv.type !== "group" && conv.participants.length <= 2)) return;

    setConfirm({
      title: t("그룹에서 나갈까요?", "Leave this group?"),
      message: t("이 그룹의 새 메시지가 더 이상 표시되지 않습니다.", "You will stop seeing new messages from this group."),
      onConfirm: async () => {
        try {
          const now = Date.now();
          const remaining = conv.participants.filter((id) => id && id !== userProfile.id);

          const leaveEvent = buildGroupLeaveEvent({
            groupId: conv.id,
            memberIds: [userProfile.id],
            actorId: userProfile.id,
            ts: now,
          });

          await saveConversation({
            ...conv,
            participants: remaining,
            hidden: true,
            lastTs: now,
            lastMessage: "Left group",
          });

          await fanoutGroupEvent(remaining, leaveEvent);
          await hydrateVault();

          if (ui.selectedConvId === conv.id) {
            setSelectedConv(null);
            setRightPanelOpen(false);
          }

          if (groupInviteConvId === conv.id) {
            setGroupInviteOpen(false);
            setGroupInviteConvId(null);
          }
        } catch (error) {
          console.error("Failed to leave group", error);
          addToast({ message: t("그룹에서 나가지 못했습니다.", "Failed to leave group.") });
        }
      },
    });
  };

  const handleSetGroupAvatarOverride = useCallback(
    async (convId: string, file: File | null) => {
      if (!userProfile) return;

      if (!file) {
        await setGroupAvatarOverride(convId, null);
        refreshGroupAvatarOverrides();

        return;
      }

      try {
        const ownerId = `group-local:${convId}:${userProfile.id}`;
        const ref = await saveGroupPhotoRef(ownerId, file);
        await setGroupAvatarOverride(convId, ref);
        refreshGroupAvatarOverrides();
      } catch (error) {
        console.error("Failed to set group avatar override", error);
        addToast({ message: t("그룹 이미지를 변경하지 못했습니다.", "Failed to update local group image.") });
      }
    },
    [addToast, refreshGroupAvatarOverrides, userProfile]
  );

  const handleSetFriendAlias = useCallback(async (friendId: string, alias: string | null) => {
    await setFriendAlias(friendId, alias);
    refreshFriendAliases();
    setFriendAliasInState(friendId, alias);
  }, [refreshFriendAliases, setFriendAliasInState]);

  const handleSubmitGroup = async (payload: {
    name: string;
    memberIds: string[];
    avatarFile?: File | null;
  }) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };

    const members = Array.from(new Set(payload.memberIds)).filter((id) => id && id !== userProfile.id);

    if (!members.length) return { ok: false as const, error: "Select at least one friend." };

    try {
      const now = Date.now();
      const convId = createId();
      let sharedAvatarRef: string | undefined;

      if (payload.avatarFile) {
        try {
          sharedAvatarRef = await saveGroupPhotoRef(convId, payload.avatarFile);
        } catch (avatarError) {
          console.error("Failed to save group avatar", avatarError);
        }
      }

      const conv: Conversation = {
        id: convId,
        type: "group",
        name: payload.name,
        pinned: false,
        unread: 0,
        hidden: false,
        muted: false,
        blocked: false,
        lastTs: now,
        lastMessage: "Group created",
        participants: [userProfile.id, ...members],
        sharedAvatarRef,
      };

      await saveConversation(conv);

      let invitationFailed = false;

      try {
        await saveMessage({
          id: createId(),
          convId: conv.id,
          senderId: userProfile.id,
          text: "Group created",
          ts: now,
        });

        const groupEvent = await syncGroupCreate({
          id: conv.id,
          name: conv.name,
          memberIds: conv.participants,
          actorId: userProfile.id,
          ts: now,
          sharedAvatarRef,
        });

        invitationFailed = Boolean(await fanoutGroupEvent(conv.participants, groupEvent, {
          allowCreateDirect: true,
          toastOnFailure: false,
          queueOnly: true,
        }));
      } catch (error) {
        console.error("Group saved but invitation preparation failed", error);
        invitationFailed = true;
      }

      await hydrateVault();

      setSelectedConv(conv.id);
      setListMode("chats");
      setListFilter("all");

      if (invitationFailed) addToast({ message: t(
        "그룹은 저장됐지만 일부 초대를 준비하지 못했습니다. 그룹 정보에서 멤버를 확인하세요.",
        "The group was saved, but some invitations could not be prepared. Check the members in group info.") });

      return { ok: true as const };
    } catch (error) {
      console.error("Failed to create group", error);

      return { ok: false as const, error: "Failed to create group." };
    }
  };

  const handleAddFriend = async (payload: { code: string; psk?: string }) => {
    const ownerGeneration = getAccountOwnerGeneration();
    const ownerAccountId = getActiveAccountId();
    type FriendAddLogExtras = Omit<
      FriendAddInfoLogInput,
      "result" | "stage" | "source" | "operationId" | "elapsedMs"
    >;

    const operationId = `friend-add:${newClientBatchId()}`;
    const traceId = operationId;
    const startedAt = nowMonotonicMs();
    const elapsedMs = () => Math.max(0, Math.round(nowMonotonicMs() - startedAt));

    const emitFriendAddWithMeta = (
      detail: Omit<FriendAddInfoLogInput, "source" | "operationId" | "elapsedMs">
    ) => {
      emitFriendAddTestLog({
        source: "app:handleAddFriend",
        operationId,
        traceId,
        elapsedMs: elapsedMs(),
        ...detail,
      });
    };

    const emitProgressWithTestLog = (
      stage: string,
      extras?: FriendAddLogExtras
    ) => {
      emitFriendAddWithMeta({
        result: "progress",
        stage,
        ...extras,
      });
    };

    const failWithTestLog = (
      errorMessage: string,
      stage: string,
      extras?: FriendAddLogExtras,
      errorCause?: unknown
    ) => {
      emitFriendAddWithMeta({
        result: "not_added",
        stage,
        message: errorMessage,
        errorDetail:
          extras?.errorDetail ?? (errorCause !== undefined ? toInfoLogErrorDetail(errorCause) : undefined),
        ...extras,
      });

      return { ok: false as const, error: errorMessage };
    };

    if (!userProfile) {
      return failWithTestLog("User profile missing.", "guard:user-profile-missing");
    }

    const rawInput = payload.code.trim();
    const normalized = normalizeInviteCode(rawInput);
    const prefixProbe = normalized.replace(/[^A-Z0-9]/g, "");

    const inputKind = prefixProbe.startsWith("NKI1")
      ? "invite"
      : prefixProbe.startsWith("NKC1")
      ? "friend-code-v1"
      : "unknown";

    emitProgressWithTestLog("progress:start", {
      message: `Friend add requested. inputKind=${inputKind}`,
      context: {
        inputKind,
        rawLength: rawInput.length,
        normalizedLength: normalized.length,
      },
    });
    let attemptKey = normalized || "empty";
    let inviteFingerprint: string | null = null;
    let legacyInviteFingerprint: string | null = null;
    let invitePsk: Uint8Array | null = null;
    let oneTimeInvite = false;

    if (prefixProbe.startsWith("NCK") || (prefixProbe.startsWith("NKC") && !prefixProbe.startsWith("NKC1"))) {
      recordFail(attemptKey);

      return failWithTestLog(
        "레거시 친구 ID(NCK-/NKC-)는 더 이상 지원하지 않습니다. 상대에게 NKC1- 친구 코드를 요청하세요.",
        "guard:legacy-code",
        {
          context: {
            inputKind,
            prefixProbe: prefixProbe.slice(0, 8),
          },
        }
      );
    }

    if (prefixProbe.startsWith("NKI1")) {
      try {
        inviteFingerprint = await computeInviteFingerprint(normalized);
        attemptKey = `invite:${inviteFingerprint}`;
      } catch (error) {
        return failWithTestLog(
          "Invite code invalid.",
          "guard:invite-fingerprint-invalid",
          {
            context: {
              inputKind,
              normalizedLength: normalized.length,
            },
          },
          error
        );
      }
    }

    const firstGate = checkAllowed(attemptKey);

    if (!firstGate.ok) {
      const waitSeconds = Math.ceil((firstGate.waitMs ?? 0) / 1000);

      return failWithTestLog(
        `Too many attempts. Try again in ${waitSeconds}s.`,
        "guard:rate-limit-initial",
        {
          context: {
            attemptKey,
            waitSeconds,
          },
        }
      );
    }

    emitProgressWithTestLog("progress:rate-limit-initial-passed", {
      context: {
        attemptKey,
      },
    });

    let friendCode = rawInput;

    if (prefixProbe.startsWith("NKI1")) {
      const decodedInvite = decodeInviteCodeV1(rawInput);

      if ("error" in decodedInvite) {
        recordFail(attemptKey);

        if (decodedInvite.error.toLowerCase().includes("expired")) {
          return failWithTestLog("Invite expired.", "decode:invite-expired");
        }

        return failWithTestLog(decodedInvite.error, "decode:invite-invalid");
      }

      oneTimeInvite = Boolean(decodedInvite.oneTime);
      legacyInviteFingerprint = inviteFingerprint;
      inviteFingerprint = await computeInviteFingerprint(normalizeInviteCode(canonicalInviteCodeV1(decodedInvite)));

      try {
        invitePsk = decodeBase64Url(decodedInvite.psk);
      } catch {
        recordFail(attemptKey);

        return failWithTestLog("Invalid invite PSK.", "decode:invite-psk-invalid");
      }

      friendCode = encodeFriendCodeV1(decodedInvite.friend);
      emitProgressWithTestLog("progress:invite-decoded", {
        message: oneTimeInvite
          ? "Invite decoded (one-time)."
          : "Invite decoded (reusable).",
        context: {
          oneTimeInvite,
          inviteFingerprint: inviteFingerprint?.slice(0, 12),
        },
      });
    }

    const decoded = decodeFriendCodeV1(friendCode);

    if ("error" in decoded) {
      recordFail(attemptKey);

      return failWithTestLog(decoded.error, "decode:friend-code-invalid", {
        context: {
          inputKind,
          oneTimeInvite,
        },
      });
    }

    const identityPubBytes = decodeBase64Url(decoded.identityPub);
    const friendId = computeFriendId(identityPubBytes);
    emitProgressWithTestLog("progress:friend-code-decoded", {
      friendId,
      context: {
        hasDeviceId: Boolean(decoded.deviceId),
        hasOnionAddr: Boolean(decoded.onionAddr),
      },
    });
    const finalKey = inviteFingerprint ? `invite:${inviteFingerprint}` : `friend:${friendId}`;

    if (finalKey !== attemptKey) {
      const gate = checkAllowed(finalKey);

      if (!gate.ok) {
        const waitSeconds = Math.ceil((gate.waitMs ?? 0) / 1000);

        return failWithTestLog(
            `Too many attempts. Try again in ${waitSeconds}s.`,
            "guard:rate-limit-friend-id",
            {
              friendId,
              context: {
                finalKey,
                waitSeconds,
              },
            }
        );
      }
    }

    emitProgressWithTestLog("progress:rate-limit-final-passed", {
      friendId,
      context: {
        finalKey,
      },
    });

    try {
      const myIdentityPub = await getIdentityPublicKey();

      if (encodeBase64Url(myIdentityPub) === decoded.identityPub) {
        recordFail(finalKey);

        return failWithTestLog("You cannot add yourself.", "guard:self-add", { friendId });
      }

      emitProgressWithTestLog("progress:self-check-passed", { friendId });
    } catch (error) {
      emitProgressWithTestLog("progress:self-check-skipped", {
        friendId,
        message: "Self-check skipped due to local identity read failure.",
        errorDetail: toInfoLogErrorDetail(error),
      });
    }

    const finalizeFriendAdd = async () => {
      try {
        const context = await captureLocalOperationContext();
        if (!context) throw new Error("OWNER_REQUIRED");
        if (context.owner.accountId !== ownerAccountId || getAccountOwnerGeneration() !== ownerGeneration) {
          throw new Error("OWNER_SESSION_CHANGED");
        }
        const profiles = await listProfiles(context.vault);
        if (!profiles.some(profile => profile.kind === "user" && profile.id === userProfile.id)) throw new Error("OWNER_PROFILE_MISMATCH");
        const existing = profiles.find(
          (friend) => friend.friendId === friendId || friend.identityPub === decoded.identityPub
        );

        emitProgressWithTestLog("progress:finalize-start", {
          friendId,
          profileId: existing?.id,
          context: {
            finalKey,
            hasExistingProfile: Boolean(existing),
            oneTimeInvite,
          },
        });

        if (existing?.friendStatus === "request_out") {
          return failWithTestLog("이미 친구 추가 요청을 보냈습니다.", "guard:duplicate-request-out", {
            friendId,
            profileId: existing.id,
            context: {
              finalKey,
              existingStatus: existing.friendStatus,
            },
          });
        }

        if (existing?.friendStatus === "normal" && hasAuthenticatedFriendKeys(existing)) {
          return failWithTestLog("이미 추가된 친구입니다.", "guard:duplicate-friend-normal", {
            friendId,
            profileId: existing.id,
            context: {
              finalKey,
              existingStatus: existing.friendStatus,
            },
          });
        }

        const tofu = applyTOFU(
          existing?.identityPub && existing?.dhPub
            ? { identityPub: existing.identityPub, dhPub: existing.dhPub }
            : null,
          { identityPub: decoded.identityPub, dhPub: decoded.dhPub }
        );

        const now = Date.now();

        if (!tofu.ok) {
          if (existing) {
            await saveProfile({
              ...existing,
              trust: {
                pinnedAt: existing.trust?.pinnedAt ?? now,
                status: "blocked",
                reason: tofu.reason,
              },
              friendStatus: "blocked",
              updatedAt: now,
            }, context.vault, existing);
            await hydrateVault();
          }

          recordFail(finalKey);

          return failWithTestLog("Friend keys changed; blocked.", "verify:tofu-blocked", {
            profileId: existing?.id,
            friendId,
            context: {
              tofuReason: tofu.reason,
            },
          });
        }

        emitProgressWithTestLog("progress:tofu-passed", {
          friendId,
          profileId: existing?.id,
          context: {
            trustStatus: existing?.trust?.status ?? "new",
          },
        });

        const psk =
          invitePsk ?? (payload.psk?.trim() ? new TextEncoder().encode(payload.psk.trim()) : null);

        if (psk) {
          await setFriendPsk(friendId, psk, context);
          emitProgressWithTestLog("progress:psk-stored", {
            friendId,
            profileId: existing?.id,
            context: {
              pskSource: invitePsk ? "invite" : "manual",
            },
          });
        }

        const routingHints = sanitizeRoutingHints(
          decoded.onionAddr || decoded.deviceId
            ? {
                onionAddr: decoded.onionAddr,
                deviceId: decoded.deviceId,
                inboxWriteToken: decoded.inboxWriteToken,
              }
            : undefined
        );

        const hasDeviceId = Boolean(decoded.deviceId);
        const hasRouteTarget = Boolean(decoded.onionAddr);
        const netConfig = useNetConfigStore.getState().config;
        const routeRequired = netConfig.mode === "onionRouter" || netConfig.onionEnabled;

        const torRouteWarmup =
          netConfig.mode === "onionRouter" && decoded.onionAddr
            ? (() => {
                const nkc = (
                  globalThis as typeof globalThis & {
                    nkc?: {
                      prewarmOnionRoute?: (
                        payload: { onionAddress: string }
                      ) => Promise<{ ok?: boolean }>;
                    };
                  }
                ).nkc;

                return nkc?.prewarmOnionRoute
                  ? nkc
                      .prewarmOnionRoute({ onionAddress: decoded.onionAddr })
                      .catch(() => ({ ok: false }))
                  : Promise.resolve({ ok: false });
              })()
            : Promise.resolve({ ok: false });

        if (!decoded.deviceId) {
          console.warn("[friend] missing deviceId in friend code; marking unreachable", {
            friendId,
          });
        } else if (routeRequired && !hasRouteTarget) {
          console.warn("[friend] missing route target in friend code; request send deferred", {
            friendId,
          });
        }

        const short = friendId.slice(0, 6);

        const reachability = (() => {
          if (hasDeviceId && (!routeRequired || hasRouteTarget)) {
            return {
              status: "ok" as const,
              attempts: existing?.reachability?.attempts ?? 0,
              lastAttemptAt: existing?.reachability?.lastAttemptAt,
              nextAttemptAt: existing?.reachability?.nextAttemptAt,
            };
          }

          return {
            status: "unreachable" as const,
            lastError: hasDeviceId
              ? "Missing onion route target in friend code"
              : "Missing deviceId in friend code",
            attempts: existing?.reachability?.attempts ?? 0,
            lastAttemptAt: Date.now(),
            nextAttemptAt: existing?.reachability?.nextAttemptAt,
          };
        })();

        const nextFriendStatus =
          existing?.friendStatus === "request_in" && hasAuthenticatedFriendKeys(existing)
            ? "normal"
            : existing?.friendStatus === "deleted" || !existing?.friendStatus || !hasAuthenticatedFriendKeys(existing)
              ? "request_out"
              : existing.friendStatus;

        const friend: UserProfile = {
          id: existing?.id ?? createId(),
          friendId,
          displayName: existing?.displayName ?? (short ? `Friend ${short}` : "Friend"),
          status: existing?.status ?? "Friend",
          theme: existing?.theme ?? "dark",
          kind: "friend",
          friendStatus: nextFriendStatus,
          friendControlTs: existing?.friendControlTs,
          friendKeysAuthenticated: existing?.friendKeysAuthenticated,
          isFavorite: existing?.isFavorite ?? false,
          identityPub: decoded.identityPub,
          dhPub: decoded.dhPub,
          routingHints,
          primaryDeviceId: decoded.deviceId ?? existing?.primaryDeviceId,
          trust: { pinnedAt: existing?.trust?.pinnedAt ?? now, status: "trusted" },
          verification: existing?.verification ?? { status: "unverified" },
          reachability,
          pskHint: Boolean(psk) || existing?.pskHint,
          profileVcard: {
            ...(existing?.profileVcard ?? {}),
            friendCode,
            updatedAt: now,
          },
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        if (existing?.friendStatus === "deleted") {
          const staleConversations = useAppStore
            .getState()
            .convs.filter(
              (conv) =>
                !(conv.type === "group" || conv.participants.length > 2) &&
                conv.participants.includes(existing.id)
          );

          for (const conversation of staleConversations) {
            await deleteConversationData(conversation.id, context.vault);
          }
        }

        await saveProfile(friend, context.vault, existing);

        if (existing?.friendStatus === "request_in") {
          const existingConv = convs.find(
            (conv) =>
              !(conv.type === "group" || conv.participants.length > 2) &&
              conv.participants.includes(friend.id)
          );

          if (existingConv) {
            await saveConversation({
              ...existingConv,
              pendingAcceptance: false,
              pendingOutgoing: false,
              pendingFriendResponse: undefined,
              hidden: false,
            }, context.vault);
          }
        }

        emitProgressWithTestLog("progress:profile-saved", {
          friendId,
          profileId: friend.id,
          context: {
            friendStatus: friend.friendStatus,
            hasDeviceId: Boolean(friend.routingHints?.deviceId || friend.primaryDeviceId || friend.deviceId),
            hasRouteTarget: Boolean(friend.routingHints?.onionAddr),
          },
        });

        const profileHydration = hydrateVault();
        let requestQueued = false;
        const canAttemptRequest = hasDeviceId && (!routeRequired || hasRouteTarget);

        if (canAttemptRequest) {
          emitProgressWithTestLog("progress:request-send-attempt", {
            friendId,
            profileId: friend.id,
            requestSent: false,
            context: {
              requestTraceId: traceId,
              convPendingOutgoing: friend.friendStatus === "request_out",
            },
          });
          requestQueued = true;
          void (async () => {
            try {
              await Promise.all([profileHydration, torRouteWarmup]);
              const requestSent = await sendFriendRequestForFriend(friend, traceId);
              emitProgressWithTestLog(
                requestSent ? "progress:request-send-success" : "progress:request-send-deferred",
                {
                  friendId,
                  profileId: friend.id,
                  requestSent,
                  context: {
                    requestTraceId: traceId,
                    retryExpected: !requestSent,
                  },
                }
              );
            } catch (error) {
              console.warn("[friend] failed to send friend request", error);
              emitProgressWithTestLog("progress:request-send-error", {
                friendId,
                profileId: friend.id,
                message: error instanceof Error ? error.message : String(error),
                requestSent: false,
                errorDetail: toInfoLogErrorDetail(error),
                context: {
                  checkpoint: "sendFriendRequestForFriend",
                  requestTraceId: traceId,
                  retryExpected: true,
                },
              });
            }
          })();
        } else {
          emitProgressWithTestLog("progress:request-send-skipped", {
            friendId,
            profileId: friend.id,
            requestSent: false,
            context: {
              requestTraceId: traceId,
              missingDeviceId: !hasDeviceId,
              missingRouteTarget: routeRequired && !hasRouteTarget,
            },
          });
        }

        if (!requestQueued) {
          await profileHydration;

          if (!hasDeviceId) {
            addToast({
              message:
                t("친구는 추가되었지만 코드에 기기 ID가 없어 요청을 보낼 수 없습니다. 상대가 최신 버전에서 코드를 다시 복사해 보내야 합니다.", "Friend saved, but the code has no device ID. Ask them to copy their code again using the latest version."),
            });
            emitFriendAddWithMeta({
              result: "added",
              stage: "result:added-missing-device-id",
              message: "Friend added without deviceId; friend request not sent.",
              profileId: friend.id,
              friendId,
              requestSent: false,
              context: {
                finalKey,
                hasDeviceId: false,
                retryExpected: false,
              },
            });

            return {
              ok: true as const,
            };
          }

          if (routeRequired && !hasRouteTarget) {
            addToast({
              message:
                t("친구는 추가되었지만 코드에 onion 주소가 없어 요청을 보낼 수 없습니다. 상대에게 최신 친구 코드를 요청하거나, 내 코드를 보내 상대가 먼저 추가하도록 안내해 주세요.", "Friend saved, but the code has no Onion address. Ask for their latest code or share yours so they can add you first."),
            });
            emitFriendAddWithMeta({
              result: "added",
              stage: "result:added-missing-route-target",
              message: "Friend added without route target; friend request not sent.",
              profileId: friend.id,
              friendId,
              requestSent: false,
              context: {
                finalKey,
                hasDeviceId: true,
                hasRouteTarget: false,
                retryExpected: false,
              },
            });

            return {
              ok: true as const,
            };
          }

          addToast({
            message:
              t("친구를 목록에 추가했습니다. 요청 전송이 지연되어 백그라운드에서 재시도됩니다.", "Friend saved. Request delivery is delayed and will retry in the background."),
          });
          emitFriendAddWithMeta({
            result: "added",
            stage: "result:added-request-delayed",
            message: "Friend added; request send delayed and scheduled for retry.",
            profileId: friend.id,
            friendId,
            requestSent: false,
            context: {
              finalKey,
              hasDeviceId: true,
              hasRouteTarget: true,
              retryExpected: true,
            },
          });

          return {
            ok: true as const,
          };
        }

        await profileHydration;
        devLog("friend:add:queued", { id: friend.id, friendId });
        emitFriendAddWithMeta({
          result: "added",
          stage: "result:added-request-queued",
          message: "Friend added locally; Tor request queued for background delivery.",
          profileId: friend.id,
          friendId,
          requestSent: false,
          context: {
            finalKey,
            retryExpected: true,
          },
        });

        recordSuccess(finalKey);

        return { ok: true as const };
      } catch (error) {
        console.error("Friend:add failed", error);
        recordFail(finalKey);

        return failWithTestLog(
          "Failed to add friend.",
          "exception:add-failed",
          {
            friendId,
            context: {
              finalKey,
              checkpoint: "finalizeFriendAdd",
            },
          },
          error
        );
      }
    };

    const runGuardedFriendAdd = async () => {
      if (oneTimeInvite && inviteFingerprint) {
        emitProgressWithTestLog("progress:invite-guard-check", {
          friendId,
          context: {
            inviteFingerprint: inviteFingerprint.slice(0, 12),
          },
        });

        const guarded = await runOneTimeInviteGuard(
          inviteFingerprint,
          finalizeFriendAdd,
          (result) => result.ok,
          legacyInviteFingerprint ? [legacyInviteFingerprint] : []
        );

        if (!guarded.ok) {
          recordFail(finalKey);

          return failWithTestLog("Invite already used.", "guard:invite-already-used", {
            friendId,
            context: {
              inviteFingerprint: inviteFingerprint.slice(0, 12),
            },
          });
        }

        emitProgressWithTestLog("progress:invite-guard-passed", {
          friendId,
          context: {
            inviteFingerprint: inviteFingerprint.slice(0, 12),
          },
        });

        return guarded.value;
      }

      return finalizeFriendAdd();
    };

    const existingAdd = friendAddInFlightRef.current.get(finalKey);

    if (existingAdd) return existingAdd;
    const pendingAdd = runGuardedFriendAdd();
    friendAddInFlightRef.current.set(finalKey, pendingAdd);

    try {
      return await pendingAdd;
    } finally {
      if (friendAddInFlightRef.current.get(finalKey) === pendingAdd) {
        friendAddInFlightRef.current.delete(finalKey);
      }
    }
  };

  const currentConversation = ui.selectedConvId
    ? convs.find((conv) => conv.id === ui.selectedConvId) || null
    : null;

  const currentTransportStatus = currentConversation
    ? transportStatusByConv[currentConversation.id] ??
      getTransportStatus(currentConversation.id)
    : null;

  const groupInviteConversation = groupInviteConvId
    ? convs.find((conv) => conv.id === groupInviteConvId) || null
    : null;

  const groupInviteExistingMemberIds = groupInviteConversation?.participants ?? [];

  const nameMap = useMemo(
    () =>
      buildNameMap(
        [...(friends || []), ...(userProfile ? [userProfile] : [])],
        friendAliasesById
      ),
    [friendAliasesById, friends, userProfile]
  );

  const profilesById = useMemo(() => {
    const map: Record<string, UserProfile> = {};
    friends.forEach((friend) => {
      map[friend.id] = friend;
    });

    if (userProfile) {
      map[userProfile.id] = userProfile;
    }

    return map;
  }, [friends, userProfile]);

  const currentGroupAvatarRef = currentConversation
    ? groupAvatarRefsByConv[currentConversation.id]
    : undefined;

  const currentGroupAvatarOverrideRef = currentConversation
    ? groupAvatarOverrides[currentConversation.id] ?? null
    : null;

  useEffect(() => {
    const prev = activeSyncConvRef.current;

    if (prev && prev !== ui.selectedConvId) {
      void disconnectSyncConversation(prev).catch(() => console.warn("[sync] conversation disconnect deferred"));
    }

    if (!ui.selectedConvId || !userProfile) {
      activeSyncConvRef.current = null;

      return;
    }

    const conv = convs.find((item) => item.id === ui.selectedConvId);

    if (!conv) return;

    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;

    if (!isDirect) return;

    const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
    const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

    if (!partner?.identityPub || !partner.dhPub) return;

    void connectSyncConversation(conv.id, {
      friendKeyId: partner.friendId ?? partner.id,
      identityPub: partner.identityPub,
      dhPub: partner.dhPub,
      onionAddr: partner.routingHints?.onionAddr,
      peerDeviceId: partner.primaryDeviceId ?? partner.routingHints?.deviceId,
      inboxWriteToken: partner.routingHints?.inboxWriteToken,
    }).catch(error => {
      console.warn("[sync] conversation session unavailable", error instanceof Error ? error.message.match(/^[A-Z_]+$/)?.[0] ?? "UNCLASSIFIED" : "UNCLASSIFIED");
    });
    const onionAddress = partner.routingHints?.onionAddr?.trim().toLowerCase();

    const prewarmActiveTorRoute = () => {
      if (!onionAddress || netConfig.mode !== "onionRouter") return;
      const lastPrewarmedAt = prewarmedOnionRoutesRef.current.get(onionAddress) ?? 0;

      if (Date.now() - lastPrewarmedAt < 45_000) return;

      const nkc = (
        globalThis as typeof globalThis & {
          nkc?: {
            prewarmOnionRoute?: (payload: { onionAddress: string }) => Promise<{ ok?: boolean }>;
          };
        }
      ).nkc;

      if (nkc?.prewarmOnionRoute) {
        prewarmedOnionRoutesRef.current.set(onionAddress, Date.now());
        void nkc
          .prewarmOnionRoute({ onionAddress })
          .then((result) => {
            if (!result?.ok) prewarmedOnionRoutesRef.current.delete(onionAddress);
          })
          .catch(() => prewarmedOnionRoutesRef.current.delete(onionAddress));
      }
    };

    prewarmActiveTorRoute();
    const torRouteKeepalive = window.setInterval(prewarmActiveTorRoute, 50_000);
    activeSyncConvRef.current = conv.id;

    return () => window.clearInterval(torRouteKeepalive);
  }, [ui.selectedConvId, convs, friends, netConfig.mode, userProfile]);

  const partnerProfile = useMemo(() => {
    if (!currentConversation) return null;

    const isGroup =
      currentConversation.type === "group" || currentConversation.participants.length > 2;

    if (isGroup) return null;
    const partnerId = currentConversation.participants.find((id) => id !== userProfile?.id);

    return friends.find((friend) => friend.id === partnerId) || null;
  }, [currentConversation, friends, userProfile]);

  const { currentTrustState } = useTrustState({
    friends,
    currentConversation,
    currentTransportStatus,
    partnerProfile,
  });

  const currentConversationDisplayName = useMemo(() => {
    if (!currentConversation) return "대화를 선택해주세요.";

    const isGroup =
      currentConversation.type === "group" || currentConversation.participants.length > 2;

    if (isGroup) return currentConversation.name;

    return resolveFriendDisplayName(partnerProfile ?? undefined, friendAliasesById);
  }, [currentConversation, friendAliasesById, partnerProfile]);

  const sendFriendResponseControl = useCallback(
    async (
      conv: Conversation,
      partner: UserProfile,
      response: PendingFriendResponseType,
      context: ReceiveContext
    ): Promise<{ ok: true } | { ok: false; reason: "missing-device" | "send-failed" }> => {
      const traceId = `friend-response:${response}:${newClientBatchId()}`;
      const routingMeta = buildRoutingMeta(partner);

      if (!routingMeta.toDeviceId) {
        return { ok: false, reason: "missing-device" };
      }

      const [identityPub, dhPub] = await Promise.all([getIdentityPublicKey(context), getDhPublicKey(context)]);
      const localFriendCodePayload = await buildLocalFriendCodePayload(context);

      const localFriendCode = encodeFriendCodeV1({
        v: 1,
        ...localFriendCodePayload,
      });

      const privacyPrefs = await getPrivacyPrefs(context);
      const avatar = userProfile ? await encodeProfileAvatar(userProfile, context) : undefined;

      const payload =
        response === "accept"
          ? {
              type: "friend_accept" as const,
              convId: conv.id,
              traceId,
              from: {
                identityPub: encodeBase64Url(identityPub),
                dhPub: encodeBase64Url(dhPub),
                deviceId: getOrCreateDeviceId(context),
                friendCode: localFriendCode,
              },
              profile: {
                displayName: userProfile?.displayName,
                status: userProfile?.status,
                avatarRef: userProfile?.avatarRef,
                ...(avatar ? { avatar } : {}),
                presence: userProfile?.id
                  ? createSharedProfilePresence(
                      userProfile.presence?.status ?? "online",
                      privacyPrefs.hidePresence
                    )
                  : undefined,
              },
              ts: Date.now(),
            }
          : {
              type: "friend_decline" as const,
              convId: conv.id,
              traceId,
              from: {
                identityPub: encodeBase64Url(identityPub),
                dhPub: encodeBase64Url(dhPub),
                deviceId: getOrCreateDeviceId(context),
                friendCode: localFriendCode,
              },
              ts: Date.now(),
            };

      const sent = await sendFriendControlPacket(conv, partner, payload, context);

      return sent ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    [buildLocalFriendCodePayload, buildRoutingMeta, sendFriendControlPacket, userProfile]
  );

  const handleRequestDeletedContact = async () => {
    if (
      !currentConversation ||
      !partnerProfile ||
      partnerProfile.friendStatus !== "deleted"
    ) return;

    if (friendResponseInFlightRef.current.has(currentConversation.id)) return;
    friendResponseInFlightRef.current.add(currentConversation.id);
    setFriendActionPendingConvId(currentConversation.id);
    try {
      const context = await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      const updatedFriend = await applyLocalFriendResponse(currentConversation.id, partnerProfile.id, "request", context.vault);
      await hydrateVault();
      context.vault.assertLocal();
      void sendFriendRequestForFriend(updatedFriend, undefined, true, context)
        .then((sent) => {
          context.vault.assertLocal();
          addToast({
            message: sent
              ? t("친구 요청을 보냈습니다.", "Friend request sent.")
              : t("친구 요청 전송이 지연되어 백그라운드에서 다시 시도합니다.", "Friend request delivery is delayed. NKC will retry in the background."),
          });
        })
        .catch((error) => {
          try { context.vault.assertLocal(); } catch { return; }
          console.warn("[friend] reconnect request failed", error);
          addToast({ message: t("친구 요청 전송이 지연되어 백그라운드에서 다시 시도합니다.", "Friend request delivery is delayed. NKC will retry in the background.") });
        });
    } catch (error) {
      console.error("Failed to request deleted contact", error);
      addToast({ message: t("친구 요청을 준비하지 못했습니다.", "Could not prepare the friend request.") });
    } finally {
      friendResponseInFlightRef.current.delete(currentConversation.id);
      setFriendActionPendingConvId((current) =>
        current === currentConversation.id ? null : current
      );
    }
  };

  const handleBlockDeletedContact = async () => {
    if (
      !currentConversation ||
      !partnerProfile ||
      partnerProfile.friendStatus !== "deleted"
    ) return;

    if (friendResponseInFlightRef.current.has(currentConversation.id)) return;
    friendResponseInFlightRef.current.add(currentConversation.id);
    setFriendActionPendingConvId(currentConversation.id);

    try {
      const context = await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      await applyLocalFriendResponse(currentConversation.id, partnerProfile.id, "block", context.vault);
      await hydrateVault();
      context.vault.assertLocal();
      setSelectedConv(null);
      setRightPanelOpen(false);
      addToast({ message: t("상대를 차단했습니다.", "Friend blocked.") });
    } catch (error) {
      console.error("Failed to block deleted contact", error);
      addToast({ message: t("차단하지 못했습니다.", "Could not block the friend.") });
    } finally {
      friendResponseInFlightRef.current.delete(currentConversation.id);
      setFriendActionPendingConvId((current) =>
        current === currentConversation.id ? null : current
      );
    }
  };

  const handleAcceptRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    const conv = currentConversation;
    const partner = partnerProfile;

    if (friendResponseInFlightRef.current.has(conv.id)) return;
    friendResponseInFlightRef.current.add(conv.id);
    setFriendActionPendingConvId(conv.id);

    try {
      const context = await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      await applyLocalFriendResponse(conv.id, partner.id, "accept", context.vault);
      await hydrateVault();
      const outcome = await sendFriendResponseControl(conv, partner, "accept", context);

      if (!outcome.ok) {
        addToast({
          message:
            outcome.reason === "missing-device"
              ? t("상대 기기 정보가 없어 수락 전송이 지연됩니다. 정보가 갱신되면 자동 재시도합니다.", "Acceptance delivery is delayed because device information is missing. NKC will retry when it becomes available.")
              : t("수락 전송이 지연되었습니다. 백그라운드에서 자동 재시도합니다.", "Acceptance delivery is delayed. NKC will retry in the background."),
        });

        return;
      }

      await completePendingFriendResponse(conv.id, "accept", context.vault);
      await hydrateVault();
      const latestProfile = useAppStore.getState().userProfile;

      if (latestProfile) {
        void profileBroadcastRef.current(latestProfile, true).catch((error) =>
          console.warn("[profile] post-accept broadcast failed", error)
        );
      }
    } catch (error) {
      console.error("Failed to accept request", error);
      addToast({ message: t("수락은 저장되었으며 상대 전송을 백그라운드에서 다시 시도합니다.", "Acceptance saved. NKC will retry delivery in the background.") });
    } finally {
      friendResponseInFlightRef.current.delete(conv.id);
      setFriendActionPendingConvId((current) => current === conv.id ? null : current);
    }
  };

  useEffect(() => {
    if (!userProfile) return;
    const schedulerOwnerId = userProfile.id;

    const scheduler = startFriendRequestScheduler({
      getTargets: () => {
        const state = useAppStore.getState();

        if (state.userProfile?.id !== schedulerOwnerId) return [];
        const config = useNetConfigStore.getState().config;
        const routeRequired = config.mode === "onionRouter" || config.onionEnabled;

        if (!routeRequired) {
          return state.friends;
        }

        return state.friends.filter((friend) => {
          if (friend.routingHints?.onionAddr) {
            return true;
          }

          const code = friend.profileVcard?.friendCode?.trim();

          if (!code) return false;
          const decoded = decodeFriendCodeV1(code);

          if ("error" in decoded) return false;

          return Boolean(decoded.onionAddr);
        });
      },
      onAttempt: async (friend) => {
        if (useAppStore.getState().userProfile?.id !== schedulerOwnerId) {
          return false;
        }

        try {
          return await sendFriendRequestForFriend(friend);
        } catch (error) {
          console.warn("[friend] request retry failed", error);

          return false;
        }
      },
      onUpdate: async (friendId, patch) => {
        const state = useAppStore.getState();

        if (state.userProfile?.id !== schedulerOwnerId) return;
        const latest = state.friends.find((item) => item.id === friendId);

        if (!latest) return;
        await saveProfile({
          ...latest,
          ...patch,
          updatedAt: Date.now(),
        });
        await hydrateVault();
      },
    });

    let wasConnected = getConnectionStatus().state === "connected";

    const unsubscribe = onConnectionStatus((status) => {
      const connected = status.state === "connected";

      if (connected && !wasConnected) scheduler.wake();
      wasConnected = connected;
    });

    return () => { unsubscribe(); scheduler.stop(); };
  }, [hydrateVault, sendFriendRequestForFriend, userProfile]);

  useEffect(() => {
    if (!userProfile) return;

    const ownerGeneration = getAccountOwnerGeneration();
    const scheduler = startFriendResponseScheduler({
      getTargets: () => {
        const state = useAppStore.getState();
        const myId = state.userProfile?.id;

        if (!myId) return [];

        return state.convs.flatMap((conv) => {
          const pending = conv.pendingFriendResponse;

          if (pending !== "accept" && pending !== "decline") return [];

          const isDirect =
            !(conv.type === "group" || conv.participants.length > 2) &&
            conv.participants.length === 2;

          if (!isDirect) return [];
          const friendId = conv.participants.find((id) => id && id !== myId);

          if (!friendId) return [];
          const partner = state.friends.find((friend) => friend.id === friendId);

          if (!partner) return [];
          if (pending === "accept" && (partner.friendStatus !== "normal" || conv.blocked)) return [];

          return [{ convId: conv.id, friendId: partner.id, response: pending }];
        });
      },
      onAttempt: async (target) => {
        if (friendResponseInFlightRef.current.has(target.convId)) return false;
        friendResponseInFlightRef.current.add(target.convId);
        const state = useAppStore.getState();
        const conv = state.convs.find((item) => item.id === target.convId);
        const partner = state.friends.find((item) => item.id === target.friendId);

        try {
          if (!conv || !partner) return false;
          if (getAccountOwnerGeneration() !== ownerGeneration) return false;
          const context = await captureLocalOperationContext();
          if (!context || getAccountOwnerGeneration() !== ownerGeneration) return false;
          context.vault.assertLocal();
          const outcome = await sendFriendResponseControl(conv, partner, target.response, context);

          if (!outcome.ok) return false;
          await completePendingFriendResponse(conv.id, target.response, context.vault);
          await hydrateVault();

          return true;
        } catch (error) {
          console.warn("[friend] response retry failed", error);

          return false;
        } finally {
          friendResponseInFlightRef.current.delete(target.convId);
        }
      },
    });

    return () => scheduler.stop();
  }, [hydrateVault, sendFriendResponseControl, userProfile]);

  const runBackgroundSync = useCallback(async () => {
    await syncContactsNow();
    await syncConversationsNow();

    if (activeSyncConvRef.current) {
      await syncConversation(activeSyncConvRef.current);
    }

    await hydrateVault();
  }, [hydrateVault]);

  useEffect(() => {
    const unsubscribe = onSyncRun((payload) => {
      if (!payload?.requestId) return;

      const complete = (ok: boolean, error?: string) => {
        try {
          reportSyncResult({ requestId: payload.requestId, ok, error });
        } catch (reportError) {
          console.error("Failed to report sync result", reportError);
        }
      };

      void (async () => {
        if (ui.mode !== "app") {
          throw new Error("app-not-ready");
        }

        await runBackgroundSync();
      })()
        .then(() => complete(true))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          complete(false, message);
        });
    });

    return () => {
      unsubscribe();
    };
  }, [runBackgroundSync, ui.mode]);

  const handleDeclineRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    const conv = currentConversation;
    const partner = partnerProfile;

    if (friendResponseInFlightRef.current.has(conv.id)) return;
    friendResponseInFlightRef.current.add(conv.id);
    setFriendActionPendingConvId(conv.id);

    let decisionStored = false;
    try {
      const context = await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      await applyLocalFriendResponse(conv.id, partner.id, "decline", context.vault);
      decisionStored = true;
      await hydrateVault();
      const outcome = await sendFriendResponseControl(conv, partner, "decline", context);

      if (!outcome.ok) {
        addToast({
          message:
            outcome.reason === "missing-device"
              ? t("상대 기기 정보가 없어 거절 전송이 지연됩니다. 정보가 갱신되면 자동 재시도합니다.", "Rejection delivery is delayed because device information is missing. NKC will retry when it becomes available.")
              : t("거절 전송이 지연되었습니다. 백그라운드에서 자동 재시도합니다.", "Rejection delivery is delayed. NKC will retry in the background."),
        });

        return;
      }

      await completePendingFriendResponse(conv.id, "decline", context.vault);
      await hydrateVault();
    } catch (error) {
      console.error("Failed to decline request", error);
      addToast({ message: decisionStored
        ? t("차단은 저장되었으며 상대 전송을 백그라운드에서 다시 시도합니다.", "Block saved. NKC will retry delivery in the background.")
        : t("요청 거절을 저장하지 못했습니다. 다시 시도해주세요.", "Could not save the rejection. Please try again.") });
    } finally {
      friendResponseInFlightRef.current.delete(conv.id);
      setFriendActionPendingConvId((current) => current === conv.id ? null : current);
    }
  };

  const handleCancelOutgoingFriendRequest = async () => {
    if (!currentConversation || !partnerProfile) return;

    try {
      const initiatingGeneration = getAccountOwnerGeneration();
      const context = await captureLocalOperationContext();
      if (!context || initiatingGeneration !== getAccountOwnerGeneration()) throw new Error("OWNER_SESSION_CHANGED");
      const friend = (await listProfiles(context.vault)).find(row => row.id === partnerProfile.id && row.kind === "friend");
      const conversation = (await listConversations(context.vault)).find(row => row.id === currentConversation.id);
      if (!friend || !conversation?.participants.includes(friend.id)) throw new Error("OWNER_PEER_MISMATCH");
      friendRequestInFlightRef.current.delete(partnerProfile.id);
      delete friendRouteWakeSignatureRef.current[partnerProfile.id];
      await applyLocalFriendResponse(conversation.id, friend.id, "cancel", context.vault);
      for (const row of await context.vault.db.outbox.where("convId").equals(conversation.id).toArray()) {
        if (row.ownerAccountId !== context.owner.accountId || row.recipientIdentityPub !== friend.identityPub) continue;
        let type: unknown;
        try { type = JSON.parse(legacyOutboxCiphertext(row)).type; } catch { continue; }
        if (type === "friend_req") await cancelInvalidatedOutgoing(row, context.vault);
      }
      context.vault.assertLocal();
      await hydrateVault();
      addToast({ message: t("친구 추가 요청을 취소했습니다.", "Friend request cancelled.") });

      if (ui.selectedConvId === currentConversation.id) {
        setSelectedConv(null);
      }
    } catch (error) {
      console.error("Failed to cancel outgoing friend request", error);
      addToast({ message: t("친구 추가 요청 취소에 실패했습니다.", "Could not cancel the friend request.") });
    }
  };

  const handleClearPendingMessages = async () => {
    const accountId = getActiveAccount().id;
    const queueSession = window.p2pQueue ? await acquireMainAccountSession(accountId) : undefined;
    stopOutboxScheduler();
    outboxSchedulerStarted.current = false;
    friendRequestInFlightRef.current.clear();

    try {
      const state = useAppStore.getState();

      const pendingFriendIds = new Set(
        state.friends
          .filter((friend) => friend.friendStatus === "request_out")
          .map((friend) => friend.id)
      );

      const now = Date.now();

      await Promise.all(
        state.friends
          .filter((friend) => pendingFriendIds.has(friend.id))
          .map((friend) =>
            saveProfile({
              ...friend,
              friendStatus: "hidden",
              reachability: {
                ...(friend.reachability ?? { status: "unreachable" as const }),
                status: "expired",
                nextAttemptAt: undefined,
              },
              updatedAt: now,
            })
          )
      );

      await Promise.all(
        state.convs
          .filter((conv) => conv.participants.some((id) => pendingFriendIds.has(id)))
          .map((conv) =>
            saveConversation({
              ...conv,
              hidden: true,
              pendingAcceptance: false,
              pendingOutgoing: false,
              pendingFriendResponse: undefined,
            })
          )
      );

      await clearOutboxQueue();
      const nativeClearResult = queueSession ? await window.p2pQueue?.clearPending(accountId, queueSession) : undefined;

      if (nativeClearResult && !nativeClearResult.ok) {
        console.warn("[account-network] failed to clear native pending queue", nativeClearResult.error);
      }

      await hydrateVault();
    } finally {
      if (useAppStore.getState().ui.mode === "app") {
        startOutboxScheduler();
        outboxSchedulerStarted.current = true;
      }
    }
  };

  if (ui.mode === "onboarding") {
    return (
      <>
        <Onboarding
          onCreate={handleCreate}
          onUnlockWithStartKey={handleStartKeyUnlock}
          defaultTab={defaultTab}
          errorMessage={onboardingError}
        />
        <Toasts />
      </>
    );
  }

  const appShell = (
    <div className="flex h-full min-w-0 overflow-hidden bg-nkc-bg">
      <Sidebar
        convs={convs}
        friends={friends}
        userId={userProfile?.id || null}
        currentUser={userProfile}
        groupAvatarRefsByConv={groupAvatarRefsByConv}
        friendAliasesById={friendAliasesById}
        selectedConvId={ui.selectedConvId}
        networkStatus={sidebarNetworkStatus}
        listMode={ui.listMode}
        listFilter={ui.listFilter}
        search={ui.search}
        onSearch={setSearch}
        onSelectConv={handleSelectConv}
        onAddFriend={() => setFriendAddDialogOpen(true)}
        onCreateGroup={handleCreateGroup}
        onFriendChat={handleFriendChat}
        onFriendViewProfile={handleFriendViewProfile}
        onFriendToggleFavorite={handleFriendToggleFavorite}
        onFriendHide={handleFriendHide}
        onFriendDelete={handleFriendDelete}
        onFriendBlock={handleFriendBlock}
        onSetFriendAlias={handleSetFriendAlias}
        onListModeChange={setListMode}
        onListFilterChange={setListFilter}
        theme={userProfile?.theme ?? "dark"}
        onToggleTheme={handleToggleTheme}
        onSettings={() => navigate("/settings")}
        onEditProfile={() => setProfileEditorOpen(true)}
        onSetPresence={(presenceStatus) =>
          handleSaveProfile({
            displayName: userProfile?.displayName ?? "",
            status: userProfile?.status ?? "",
            theme: userProfile?.theme ?? "dark",
            presenceStatus,
          })
        }
        onCopyFriendCode={handleCopyFriendCode}
        onHide={handleHide}
        onDelete={handleDelete}
        onTogglePin={handleTogglePin}
        onMute={handleMute}
        onBlock={handleBlock}
      />

      <ChatView
        key={`${getActiveAccountId()}:${getAccountOwnerGeneration()}:${currentConversation?.id ?? "none"}`}
        conversation={currentConversation}
        conversationDisplayName={currentConversationDisplayName}
        transportStatus={currentTransportStatus}
        currentUserId={userProfile?.id || null}
        nameMap={nameMap}
        profilesById={profilesById}
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSendBatch={handleSendBatch}
        onSendReadReceipt={handleSendReadReceipt}
        onAcceptRequest={handleAcceptRequest}
        onDeclineRequest={handleDeclineRequest}
        onRequestDeletedContact={handleRequestDeletedContact}
        onBlockDeletedContact={handleBlockDeletedContact}
        onCancelOutgoingRequest={handleCancelOutgoingFriendRequest}
        friendActionBusy={friendActionPendingConvId === currentConversation?.id}
        onDeleteMessages={handleDeleteMessages}
        onToast={(message) => addToast({ message })}
        onBack={() => {
          setSelectedConv(null);
          setRightPanelOpen(false);
        }}
        onToggleRight={() => setRightPanelOpen(!ui.rightPanelOpen)}
        rightPanelOpen={ui.rightPanelOpen}
      />

      <RightPanel
        open={ui.rightPanelOpen}
        onClose={() => setRightPanelOpen(false)}
        tab={ui.rightTab}
        onTabChange={setRightTab}
        conversation={currentConversation}
        friendProfile={partnerProfile}
        currentUserId={userProfile?.id ?? null}
        profilesById={profilesById}
        groupAvatarRef={currentGroupAvatarRef}
        groupAvatarOverrideRef={currentGroupAvatarOverrideRef}
        friendAliasesById={friendAliasesById}
        trustState={currentTrustState}
        onOpenSettings={() => navigate("/settings")}
        onInviteToGroup={handleInviteToGroup}
        onLeaveGroup={handleLeaveGroup}
        onSetGroupAvatarOverride={handleSetGroupAvatarOverride}
        onToggleMute={handleMute}
        onTogglePin={handleTogglePin}
        onHideConversation={handleHide}
        onToggleBlock={handleBlock}
      />

      {profileEditorOpen && userProfile ? (
        <ProfileEditorDialog
          open={profileEditorOpen}
          user={userProfile}
          onOpenChange={setProfileEditorOpen}
          onSave={({ displayName, status, avatarFile }) =>
            handleSaveProfile({
              displayName,
              status,
              theme: userProfile.theme,
              presenceStatus: userProfile.presence?.status ?? "online",
              avatarFile,
            })
          }
        />
      ) : null}

      {settingsOpen && userProfile ? (
        <Suspense fallback={null}>
          <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open) navigate("/");
          }}
          user={userProfile}
          onSaveProfile={handleSaveProfile}
          onOpenProfileEditor={() => {
            navigate("/");
            setProfileEditorOpen(true);
          }}
          onLock={handleLock}
          pinEnabled={pinEnabled}
          onSetPin={handleSetPin}
          onDisablePin={handleDisablePin}
          onRotateStartKey={handleRotateStartKey}
          hiddenFriends={friends.filter((friend) => friend.friendStatus === "hidden")}
          blockedFriends={friends.filter((friend) => friend.friendStatus === "blocked")}
          onUnhideFriend={handleFriendUnhide}
          onUnblockFriend={handleFriendUnblock}
          onLogout={() =>
            setConfirm({
              title: t("로그아웃할까요?", "Sign out?"),
              message: t("세션을 종료하고 로컬 데이터는 유지됩니다.", "End this session and keep local data."),
              onConfirm: handleLogout,
            })
          }
          onClearPendingMessages={handleClearPendingMessages}
          onWipe={() =>
            setConfirm({
              title: t("현재 계정을 삭제할까요?", "Delete the current account?"),
              message: t("이 계정의 암호 키, 로컬 DB, 전송 대기열을 삭제합니다. 되돌릴 수 없으며 다른 기기나 OS 백업의 사본은 별도로 삭제해야 합니다.", "Delete this account’s encryption keys, local database and pending queue. This cannot be undone. Copies on other devices or OS backups must be deleted separately."),
              onConfirm: async () => {
                const deletedAccount = getActiveAccount();
                const deletedDeviceId = getOrCreateDeviceId();
                friendRequestInFlightRef.current.clear();
                stopOutboxScheduler();
                outboxSchedulerStarted.current = false;
                resetAppState();
                await clearStoredSession();
                await wipePinState();
                await window.nkc?.unregisterOnionMailbox?.(deletedDeviceId,
                  await acquireMainAccountSession(deletedAccount.id)).catch((error) => {
                  console.warn("[account-network] failed to unregister mailbox", error);
                });
                await wipeVault(deletedAccount.dbName);
                await window.p2pQueue?.removeAccount(deletedAccount.id, await acquireMainAccountSession(getActiveAccount().id)).catch((error) => {
                  console.warn("[account-network] failed to remove queue partition", error);
                });
                await removeAccountSecrets(deletedAccount);
                removeAccountLocalStorage(deletedAccount);
                removeLocalAccount(deletedAccount.id);
                window.location.reload();
              },
            })
          }
          />
        </Suspense>
      ) : null}

      {userProfile ? (
        <FriendAddDialog
          open={friendAddOpen}
          onOpenChange={setFriendAddDialogOpen}
          myCode={myFriendCode}
          myCodeHint={friendAddHint}
          myCodeLoading={!myFriendCode}
          routeResolveBusy={routeResolveBusy}
          onCopyCode={handleCopyFriendCode}
          onResolveRoute={handleResolveFriendRoute}
          onAdd={handleAddFriend}
        />
      ) : null}

      {userProfile ? (
        <GroupInviteDialog
          open={groupInviteOpen && Boolean(groupInviteConversation)}
          onOpenChange={(open) => {
            setGroupInviteOpen(open);

            if (!open) setGroupInviteConvId(null);
          }}
          friends={friends}
          existingMemberIds={groupInviteExistingMemberIds}
          onSubmit={(memberIds) =>
            groupInviteConversation
              ? handleSubmitGroupInvite(groupInviteConversation.id, memberIds)
              : Promise.resolve({ ok: false as const, error: "Group not found." })
          }
        />
      ) : null}

      {userProfile ? (
        <GroupCreateDialog
          open={groupCreateOpen}
          onOpenChange={setGroupCreateOpen}
          friends={friends}
          onCreate={handleSubmitGroup}
        />
      ) : null}
    </div>
  );

  return (
    <>
      <Routes>
        <Route
          path="/unlock"
          element={
            ui.mode === "locked" ? (
              <Unlock
                onUnlock={handlePinUnlock}
                onUseStartKey={async () => {
                  try {
                    await clearPinRecord();
                  } catch (error) {
                    console.warn("Failed to mark PIN reset", error);
                  }

                  setPinEnabled(true);
                  setPinNeedsReset(true);
                  setDefaultTab("startKey");
                  setMode("onboarding");
                  navigate("/");
                }}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="/start-key"
          element={
            ui.mode === "app" ? (
              <StartKey
                onRotate={handleRotateStartKey}
                onDone={() => navigate("/", { replace: true })}
              />
            ) : (
              <Navigate to="/unlock" replace />
            )
          }
        />
        <Route path="/settings" element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />} />
        <Route path="/*" element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />} />
      </Routes>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        onConfirm={() => {
          // confirm?.onConfirm()가 Promise를 반환해도 UI는 void 처리
          void confirm?.onConfirm?.();
        }}
        onClose={() => setConfirm(null)}
      />

      <Toasts />
    </>
  );
}
