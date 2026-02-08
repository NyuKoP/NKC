import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock, { type UnlockResult } from "../components/Unlock";
import StartKey from "../components/StartKey";
import FriendAddDialog from "../components/FriendAddDialog";
import GroupCreateDialog from "../components/GroupCreateDialog";
import GroupInviteDialog from "../components/GroupInviteDialog";
import Sidebar from "../components/Sidebar";
import ChatView from "../components/ChatView";
import RightPanel from "../components/RightPanel";
import SettingsDialog from "../components/SettingsDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import Toasts from "../components/Toasts";
import { createId } from "../utils/ids";
import {
  bootstrapVault,
  resetVaultStorage,
  getVaultHeader,
  listConversations,
  listProfiles,
  lockVault,
  repairVaultTextEncoding,
  verifyVaultKeyId,
  rotateVaultKeys,
  deleteProfile,
  deleteMessagesById,
  nextLamportForConv,
  getLastEventHash,
  saveConversation,
  saveEvent,
  saveMessage,
  saveMessageMedia,
  saveProfile,
  saveProfilePhoto,
  saveGroupPhotoRef,
  loadAvatarFromRef,
  seedVaultData,
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
import { decodeInviteCodeV1 } from "../security/inviteCode";
import { runOneTimeInviteGuard } from "../security/inviteUseStore";
import { checkAllowed, recordFail, recordSuccess } from "../security/rateLimit";
import { applyTOFU } from "../security/trust";
import { sha256 } from "../security/sha256";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { clearPin, clearPinRecord, getPinStatus, isPinUnavailableError, setPin as savePin, verifyPin, wipePinState } from "../security/pin";
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
import { computeEnvelopeHash, deriveConversationKey, encryptEnvelope, type EnvelopeHeader } from "../crypto/box";
import { nextSendDhKey, nextSendKey } from "../crypto/ratchet";
import { sendCiphertext } from "../net/router";
import { startOutboxScheduler } from "../net/outboxScheduler";
import { onConnectionStatus } from "../net/connectionStatus";
import { sanitizeRoutingHints } from "../net/privacy";
import {
  buildGroupInviteEvent,
  buildGroupLeaveEvent,
  syncGroupCreate,
  type GroupEventPayload,
} from "../sync/groupSync";
import {
  connectConversation as connectSyncConversation,
  disconnectConversation as disconnectSyncConversation,
  syncContactsNow,
  syncConversation,
  syncConversationsNow,
} from "../sync/syncEngine";
import {
  getTransportStatus,
  onTransportStatusChange,
  setDirectApprovalHandler,
  type ConversationTransportStatus,
} from "../net/transportManager";
import { putReadCursor } from "../storage/receiptStore";
import { getConvAllowDirect, setGroupAvatarOverride } from "../security/preferences";
import { setFriendAlias } from "../storage/friendStore";
import { resolveDisplayName, resolveFriendDisplayName } from "../utils/displayName";
import { startFriendRequestScheduler } from "../friends/friendRequestScheduler";
import {
  startFriendResponseScheduler,
  type PendingFriendResponseType,
} from "../friends/friendResponseScheduler";
import { startFriendInboxListener } from "../friends/friendInbox";
import {
  isFriendControlFrame,
  signFriendControlFrame,
  stripFriendControlFrameSignature,
  type FriendControlFrame,
  type FriendControlFrameType,
} from "../friends/friendControlFrame";
import { useProfileDecorations } from "./hooks/useProfileDecorations";
import { useTrustState } from "./hooks/useTrustState";
import { onSyncRun, reportSyncResult } from "../appControl";
import { appendTestLog } from "../utils/testLogSink";

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

const INLINE_MEDIA_MAX_BYTES = 500 * 1024 * 1024;
const INLINE_MEDIA_CHUNK_SIZE = 48 * 1024;
const READ_CURSOR_THROTTLE_MS = 1500;
const ROUTE_PENDING_TOAST_COOLDOWN_MS = 10_000;

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

type FriendAddTestLog = {
  result: "added" | "not_added";
  stage: string;
  message?: string;
  profileId?: string;
  friendId?: string;
  requestSent?: boolean;
};

type FriendRouteTestLog = {
  direction: "outgoing";
  status: "sent" | "failed";
  frameType: FriendControlFrameType;
  via?: "directP2P" | "selfOnion" | "onionRouter";
  messageId: string;
  convId: string;
  senderDeviceId?: string;
  toDeviceId?: string;
  torOnion?: string;
  lokinet?: string;
  error?: string;
  timestamp: string;
};

export default function App() {
  const ui = useAppStore((state) => state.ui);
  const userProfile = useAppStore((state) => state.userProfile);
  const friends = useAppStore((state) => state.friends);
  const convs = useAppStore((state) => state.convs);
  const messagesByConv = useAppStore((state) => state.messagesByConv);
  const setMode = useAppStore((state) => state.setMode);
  const setSelectedConv = useAppStore((state) => state.setSelectedConv);
  const setIsComposing = useAppStore((state) => state.setIsComposing);
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const setListMode = useAppStore((state) => state.setListMode);
  const setListFilter = useAppStore((state) => state.setListFilter);
  const setSearch = useAppStore((state) => state.setSearch);
  const setSessionState = useAppStore((state) => state.setSession);
  const setData = useAppStore((state) => state.setData);
  const addToast = useAppStore((state) => state.addToast);
  const confirm = useAppStore((state) => state.ui.confirm);
  const setConfirm = useAppStore((state) => state.setConfirm);

  const navigate = useNavigate();
  const location = useLocation();

  const [pinEnabled, setPinEnabled] = useState(false);
  const [defaultTab, setDefaultTab] = useState<"create" | "startKey">("create");
  const [pinNeedsReset, setPinNeedsReset] = useState(false);
  const wasHiddenRef = useRef(false);

  const [onboardingError, setOnboardingError] = useState("");
  const [friendAddOpen, setFriendAddOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupInviteOpen, setGroupInviteOpen] = useState(false);
  const [groupInviteConvId, setGroupInviteConvId] = useState<string | null>(null);
  const [myFriendCode, setMyFriendCode] = useState("");
  const [transportStatusByConv, setTransportStatusByConv] = useState<
    Record<string, ConversationTransportStatus>
  >({});

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
  const friendInboxStarted = useRef(false);
  const activeSyncConvRef = useRef<string | null>(null);
  const lastReadCursorSentAtRef = useRef<Record<string, number>>({});
  const lastReadCursorSentTsRef = useRef<Record<string, number>>({});
  const pendingReadCursorRef = useRef<
    Record<string, { cursorTs: number; anchorMsgId: string } | undefined>
  >({});
  const readCursorThrottleTimerRef = useRef<Record<string, number | undefined>>({});
  const routePendingToastRef = useRef<Record<string, number>>({});

  const connectionToastShown = useRef(false);
  const connectionToastKey = "nkc.sessionConnectedToastShown";

  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const devLog = useCallback(
    (message: string, detail?: Record<string, unknown>) => {
      if (!isDev) return;
      if (detail) console.debug(`[app] ${message}`, detail);
      else console.debug(`[app] ${message}`);
    },
    [isDev]
  );
  const emitFriendAddTestLog = useCallback((detail: FriendAddTestLog) => {
    const payload = {
      ...detail,
      timestamp: new Date().toISOString(),
    };
    console.info("[test][friend-add]", payload);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("nkc:test:friend-add", {
          detail: payload,
        })
      );
    }
  }, []);
  const emitFriendRouteTestLog = useCallback((detail: Omit<FriendRouteTestLog, "timestamp">) => {
    const payload: FriendRouteTestLog = {
      ...detail,
      timestamp: new Date().toISOString(),
    };
    console.info("[test][friend-route]", payload);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("nkc:test:friend-route", {
          detail: payload,
        })
      );
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFriendAdd = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      void appendTestLog("friend-add", detail);
    };
    const handleFriendRoute = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      void appendTestLog("friend-route", detail);
    };

    window.addEventListener("nkc:test:friend-add", handleFriendAdd as EventListener);
    window.addEventListener("nkc:test:friend-route", handleFriendRoute as EventListener);
    return () => {
      window.removeEventListener("nkc:test:friend-add", handleFriendAdd as EventListener);
      window.removeEventListener("nkc:test:friend-route", handleFriendRoute as EventListener);
    };
  }, []);

  const settingsOpen = location.pathname === "/settings";
  const getRoutePendingToast = useCallback((error?: string) => {
    const message = (error ?? "").toLowerCase();
    if (message.includes("missing destination 'to'") || message.includes("missing-to-device")) {
      return {
        key: "missing-device-id",
        text:
          "상대 기기 ID가 없어 전송 경로를 만들 수 없습니다. 친구 코드를 다시 받아 업데이트하세요.",
      };
    }
    if (message.includes("forward_failed:no_proxy") || message.includes("onion controller unavailable")) {
      return {
        key: "onion-proxy-not-ready",
        text:
          "Tor/Lokinet 프록시가 아직 준비되지 않았습니다. Onion 적용 후 연결되면 자동 재시도됩니다.",
      };
    }
    if (message.includes("direct p2p data channel is not open")) {
      return {
        key: "direct-not-open",
        text:
          "Direct P2P 연결이 아직 열리지 않았습니다. 연결 수립 후 자동 재시도됩니다.",
      };
    }
    return {
      key: "generic-route-not-ready",
      text:
        "전송 경로가 준비되지 않아 메시지가 대기열에 남았습니다. 연결 후 자동 재시도됩니다.",
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
    setSessionState({ unlocked: false, vkInMemory: false });
    setData({ user: null, friends: [], convs: [], messagesByConv: {} });
    setSelectedConv(null);
  }, [clearConnectionToastGuard, setData, setSelectedConv, setSessionState]);

  const resolveLocalRoutingHintsForFriendCode = useCallback(async () => {
    const localDeviceId = getOrCreateDeviceId();
    const fallback = sanitizeRoutingHints({
      deviceId: localDeviceId,
      onionAddr: userProfile?.routingHints?.onionAddr,
      lokinetAddr: userProfile?.routingHints?.lokinetAddr,
    });
    const nkc = (
      globalThis as {
        nkc?: {
          ensureHiddenService?: () => Promise<unknown>;
          getMyOnionAddress?: () => Promise<string>;
          getMyLokinetAddress?: () => Promise<string>;
        };
      }
    ).nkc;
    if (!nkc) return fallback;

    let onionAddr = fallback?.onionAddr;
    let lokinetAddr = fallback?.lokinetAddr;

    if (!onionAddr && nkc.ensureHiddenService) {
      try {
        await nkc.ensureHiddenService();
      } catch {
        // Best-effort only.
      }
    }
    if (nkc.getMyOnionAddress) {
      try {
        const value = (await nkc.getMyOnionAddress()).trim();
        if (value) onionAddr = value;
      } catch {
        // Best-effort only.
      }
    }
    if (nkc.getMyLokinetAddress) {
      try {
        const value = (await nkc.getMyLokinetAddress()).trim();
        if (value) lokinetAddr = value;
      } catch {
        // Best-effort only.
      }
    }

    return (
      sanitizeRoutingHints({
        deviceId: localDeviceId,
        onionAddr,
        lokinetAddr,
      }) ?? fallback
    );
  }, [userProfile?.routingHints?.lokinetAddr, userProfile?.routingHints?.onionAddr]);

  const buildLocalFriendCodePayload = useCallback(async (): Promise<Omit<FriendCodeV1, "v">> => {
    const [identityPub, dhPub, localHints] = await Promise.all([
      getIdentityPublicKey(),
      getDhPublicKey(),
      resolveLocalRoutingHintsForFriendCode(),
    ]);
    return {
      identityPub: encodeBase64Url(identityPub),
      dhPub: encodeBase64Url(dhPub),
      deviceId: getOrCreateDeviceId(),
      onionAddr: localHints?.onionAddr,
      lokinetAddr: localHints?.lokinetAddr,
    };
  }, [resolveLocalRoutingHintsForFriendCode]);

  useEffect(() => {
    if (!friendAddOpen || !userProfile) return;
    buildLocalFriendCodePayload()
      .then((payload) =>
        encodeFriendCodeV1({
          v: 1,
          ...payload,
        })
      )
      .then(setMyFriendCode)
      .catch((error) => console.error("Failed to compute friend code", error));
  }, [buildLocalFriendCodePayload, friendAddOpen, userProfile]);

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
    try {
      devLog("hydrate:start");

      const vk = getVaultKey();
      if (vk) {
        const keyOk = await withTimeout(verifyVaultKeyId(vk), "verifyVaultKeyId");
        if (!keyOk) {
          console.warn("[vault] key mismatch -> reset");
          await withTimeout(resetVaultStorage(), "resetVaultStorage");
          await clearStoredSession();
          lockVault();
          resetAppState();
          setPinEnabled(false);
          setPinNeedsReset(false);
          setDefaultTab("startKey");
          setMode("onboarding");
          return;
        }
      }

      await withTimeout(repairVaultTextEncoding(), "repairVaultTextEncoding");

      const profiles = await withTimeout(listProfiles(), "listProfiles");
      const user = profiles.find((profile) => profile.kind === "user") || null;
      const friendProfiles = profiles.filter((profile) => profile.kind === "friend");

      const conversations = await withTimeout(listConversations(), "listConversations");
      const messagesBy: Record<string, Message[]> = {};

      for (const conv of conversations) {
        if (!user) {
          messagesBy[conv.id] = [];
          continue;
        }
        const isDirect =
          !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;
        const partnerId = isDirect
          ? conv.participants.find((id) => id && id !== user.id) || null
          : null;
        const partner = partnerId
          ? friendProfiles.find((profile) => profile.id === partnerId) || null
          : null;
        messagesBy[conv.id] = await withTimeout(
          loadConversationMessages(conv, partner, user.id),
          "loadConversationMessages"
        );
      }

      setData({
        user,
        friends: friendProfiles,
        convs: conversations,
        messagesByConv: messagesBy,
      });

      setSessionState({ unlocked: true, vkInMemory: true });
      setMode("app");

      devLog("hydrate:done", { profiles: profiles.length, convs: conversations.length });
    } catch (error) {
      console.error("Failed to hydrate vault", error);

      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("ciphertext") || message.includes("decrypted") || message.includes("Vault key mismatch")) {
        try {
          await withTimeout(resetVaultStorage(), "resetVaultStorage");
        } catch (resetError) {
          console.error("Failed to reset vault storage", resetError);
        }
      }

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
          addToast({ message: "PIN must be reset. Unlock with the start key." });
        }
        setDefaultTab("startKey");
        setMode("onboarding");
      }

      addToast({ message: "세션이 만료되었으니 다시 로그인해 주세요." });
    }
  }, [
    addToast,
    devLog,
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
            await setStoredSession(session.vaultKey, undefined, { remember: true });
            await hydrateVault();
            return;
          }

          if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the start key." });
          }
          setDefaultTab("startKey");
          setMode("onboarding");
        }
      } catch (error) {
        console.error("Boot failed", error);
        addToast({ message: "초기화에 실패했습니다." });
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
  }, [ui.mode]);

  useEffect(() => {
    if (ui.mode !== "app") return;
    if (friendInboxStarted.current) return;
    startFriendInboxListener(() => {
      void hydrateVault();
    });
    friendInboxStarted.current = true;
  }, [hydrateVault, ui.mode]);

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

      addToast({ message: "세션이 연결되었습니다." });
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

    try {
      setOnboardingError("");
      devLog("onboarding:create:start");

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
        theme: "dark",
        kind: "user",
        createdAt: now,
        updatedAt: now,
      };

      await withTimeout(seedVaultData(user), "seedVaultData");
      await withTimeout(setStoredSession(vk, undefined, { remember: true }), "setStoredSession");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Vault bootstrap failed", error);
      setOnboardingError(error instanceof Error ? error.message : "금고 초기화에 실패했습니다.");
      lockVault();
      addToast({ message: "금고 초기화에 실패했습니다." });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handleStartKeyUnlock = async (startKey: string, displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;

    if (!validateStartKey(startKey)) {
      addToast({ message: "시작 키 형식이 올바르지 않습니다. (예: NKC-...)" });
      onboardingLockRef.current = false;
      return;
    }

    try {
      devLog("onboarding:start-key:start");

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
        const now = Date.now();
        const user: UserProfile = {
          id: createId(),
          displayName: displayName || "NKC User",
          status: "Hello from NKC",
          theme: "dark",
          kind: "user",
          createdAt: now,
          updatedAt: now,
        };
        await withTimeout(seedVaultData(user), "seedVaultData");
      }

      await withTimeout(setStoredSession(vk, undefined, { remember: true }), "setStoredSession");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Start key unlock failed", error);
      lockVault();
      addToast({ message: "시작 키로 잠금 해제에 실패했습니다." });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handlePinUnlock = async (pin: string): Promise<UnlockResult> => {
    const result = await verifyPin(pin);

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
      await setStoredSession(result.vaultKey, undefined, { remember: true });
      await hydrateVault();
      navigate("/");
      return { ok: true };
    } catch (error) {
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
        addToast({ message: "Reset your PIN to enable lock." });
        return;
      }
      addToast({ message: "Set a PIN to enable lock." });
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
      addToast({ message: "Lock failed." });
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
      await clearStoredSession();
      lockVault();
      resetAppState();

      const pinStatus = await getPinStatus();
      setPinEnabled(pinStatus.enabled);
      setPinNeedsReset(pinStatus.needsReset);

      if (pinStatus.enabled && !pinStatus.needsReset) {
        setMode("locked");
        navigate("/unlock");
      } else {
        if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the start key." });
        }
        setDefaultTab("startKey");
        setMode("onboarding");
        navigate("/");
      }
    } catch (error) {
      console.error("Failed to logout", error);
      addToast({ message: "로그아웃에 실패했습니다." });
    }
  };

  const handleSetPin = async (pin: string) => {
    try {
      await savePin(pin);
      setPinEnabled(true);
      setPinNeedsReset(false);
      addToast({ message: "PIN set." });
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
      addToast({ message: "PIN disabled." });
    } catch (error) {
      if (isPinUnavailableError(error)) {
        addToast({ message: "PIN lock is unavailable on this platform/build." });
        throw error;
      }
      console.error("Failed to clear PIN", error);
      addToast({ message: "Failed to disable PIN." });
      throw error;
    }
  };

  const handleRotateStartKey = async (newKey: string) => {
    try {
      if (!validateStartKey(newKey)) {
        addToast({ message: "시작 키 형식이 올바르지 않습니다. (예: NKC-...)" });
        return;
      }

      await rotateVaultKeys(newKey, () => {});
      const vk = getVaultKey();
      if (vk) await setStoredSession(vk, undefined, { remember: true });

      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);

      addToast({ message: "시작 키가 변경되었습니다. PIN을 다시 설정해 주세요." });
    } catch (error) {
      console.error("Failed to rotate start key", error);
      addToast({ message: "시작 키 변경에 실패했습니다." });
      throw error;
    }
  };

  const handleSaveProfile = async (payload: { displayName: string; status: string; theme: "dark" | "light" }) => {
    if (!userProfile) return;

    const updated: UserProfile = {
      ...userProfile,
      ...payload,
      updatedAt: Date.now(),
    };

    await saveProfile(updated);
    await hydrateVault();
  };

  const handleUploadPhoto = async (file: File) => {
    if (!userProfile) return;
    const avatarRef = await saveProfilePhoto(userProfile.id, file);
    const updated: UserProfile = {
      ...userProfile,
      avatarRef,
      updatedAt: Date.now(),
    };
    await saveProfile(updated);
    await hydrateVault();
  };


  const buildRoutingMeta = useCallback((partner: UserProfile) => {
    const toDeviceId =
      partner.routingHints?.deviceId ??
      partner.primaryDeviceId ??
      partner.deviceId;
    const torOnion = partner.routingHints?.onionAddr;
    const lokinet = partner.routingHints?.lokinetAddr;
    return {
      toDeviceId,
      route: torOnion || lokinet ? { torOnion, lokinet } : undefined,
    };
  }, []);

  const sendDirectEnvelope = useCallback(
    async (
      conv: Conversation,
      partner: UserProfile,
      body: unknown,
      priority: "high" | "normal" = "high"
    ) => {
      if (!partner.dhPub || !partner.identityPub) {
        throw new Error("Missing peer keys");
      }
      const now = Date.now();
      const friendKeyId = partner.friendId ?? partner.id;
      const lamport = await nextLamportForConv(conv.id);
      const header: EnvelopeHeader = {
        v: 1 as const,
        eventId: createId(),
        convId: conv.id,
        ts: now,
        lamport,
        authorDeviceId: getOrCreateDeviceId(),
      };
      header.prev = await getLastEventHash(conv.id);

      const dhPriv = await getDhPrivateKey();
      const theirDhPub = decodeBase64Url(partner.dhPub);
      const pskBytes = await getFriendPsk(friendKeyId);
      const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
      const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
      const conversationKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, legacyContextBytes);
      const ratchetBaseKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, ratchetContextBytes);

      const myIdentityPriv = await getIdentityPrivateKey();
      let keyForEnvelope = conversationKey;
      try {
        const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
        header.rk = ratchet.headerRk;
        keyForEnvelope = ratchet.msgKey;
      } catch {
        try {
          const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
          header.rk = ratchet.headerRk;
          keyForEnvelope = ratchet.msgKey;
        } catch (error) {
          console.warn("[ratchet] send fallback to legacy", error);
        }
      }

      const envelope = await encryptEnvelope(keyForEnvelope, header, body, myIdentityPriv);
      const envelopeJson = JSON.stringify(envelope);
      const eventHash = await computeEnvelopeHash(envelope);

      await saveEvent({
        eventId: header.eventId,
        convId: header.convId,
        authorDeviceId: header.authorDeviceId,
        lamport: header.lamport,
        ts: header.ts,
        envelopeJson,
        prevHash: header.prev,
        eventHash,
      });

      const routed = await sendCiphertext({
        convId: conv.id,
        messageId: header.eventId,
        ciphertext: envelopeJson,
        priority,
        ...buildRoutingMeta(partner),
      });
      if (!routed.ok) {
        throw new Error(routed.error ?? "Failed to route message");
      }

      return { header, envelopeJson };
    },
    [buildRoutingMeta]
  );

  const buildFriendRequestPayload = useCallback(async (convId: string) => {
    if (!userProfile) return null;
    const payload = await buildLocalFriendCodePayload();
    const friendCode = encodeFriendCodeV1({
      v: 1,
      ...payload,
    });
    return {
      type: "friend_req" as const,
      convId,
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
      },
      ts: Date.now(),
    };
  }, [buildLocalFriendCodePayload, userProfile]);

  const ensureDirectConvForFriend = useCallback(
    async (friend: UserProfile) => {
      if (!userProfile) return null;
      const existingConv = convs.find(
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
      await saveConversation(newConv);
      return newConv;
    },
    [convs, userProfile]
  );

  const sendFriendControlPacket = useCallback(
    async (
      conv: Conversation,
      partner: UserProfile,
      payload: unknown,
      priority: "high" | "normal" = "high"
    ) => {
      if (!isFriendControlFrame(payload)) {
        throw new Error("Unsupported friend control frame");
      }
      const unsignedPayload = stripFriendControlFrameSignature(payload);
      const signedPayload: FriendControlFrame = payload.sig
        ? payload
        : {
            ...unsignedPayload,
            sig: await signFriendControlFrame(unsignedPayload, await getIdentityPrivateKey()),
          };
      const frameType = signedPayload.type;
      const messageId = createId();
      const routingMeta = buildRoutingMeta(partner);
      const senderDeviceId =
        signedPayload.from?.deviceId ?? getOrCreateDeviceId();
      const result = await sendCiphertext({
        convId: conv.id,
        messageId,
        ciphertext: JSON.stringify(signedPayload),
        priority,
        ...routingMeta,
      });
      if (!result.ok) {
        emitFriendRouteTestLog({
          direction: "outgoing",
          status: "failed",
          frameType,
          via: result.transport,
          messageId,
          convId: conv.id,
          senderDeviceId,
          toDeviceId: routingMeta.toDeviceId,
          torOnion: routingMeta.route?.torOnion,
          lokinet: routingMeta.route?.lokinet,
          error: result.error ?? "Friend control packet send failed",
        });
        return false;
      }
      emitFriendRouteTestLog({
        direction: "outgoing",
        status: "sent",
        frameType,
        via: result.transport,
        messageId,
        convId: conv.id,
        senderDeviceId,
        toDeviceId: routingMeta.toDeviceId,
        torOnion: routingMeta.route?.torOnion,
        lokinet: routingMeta.route?.lokinet,
      });
      return true;
    },
    [buildRoutingMeta, emitFriendRouteTestLog]
  );

  const sendFriendRequestForFriend = useCallback(
    async (friend: UserProfile) => {
      if (!friend.routingHints?.deviceId && !friend.primaryDeviceId && !friend.deviceId) {
        return false;
      }
      const conv = await ensureDirectConvForFriend(friend);
      if (!conv) return false;
      const payload = await buildFriendRequestPayload(conv.id);
      if (!payload) return false;
      return sendFriendControlPacket(conv, friend, payload, "high");
    },
    [buildFriendRequestPayload, ensureDirectConvForFriend, sendFriendControlPacket]
  );

  const handleSendMessage = async (text: string, clientBatchId: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;

    const vk = getVaultKey();
    if (!vk) return;

    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;

    if (isDirect) {
      const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
      const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

      if (partner?.dhPub && partner.identityPub) {
        const now = Date.now();
        const friendKeyId = partner.friendId ?? partner.id;
        const lamport = await nextLamportForConv(conv.id);
        const header: EnvelopeHeader = {
          v: 1 as const,
          eventId: createId(),
          convId: conv.id,
          ts: now,
          lamport,
          authorDeviceId: getOrCreateDeviceId(),
        };
        header.prev = await getLastEventHash(conv.id);

        const dhPriv = await getDhPrivateKey();
        const theirDhPub = decodeBase64Url(partner.dhPub);
        const pskBytes = await getFriendPsk(friendKeyId);
        const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
        const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
        const conversationKey = await deriveConversationKey(
          dhPriv,
          theirDhPub,
          pskBytes,
          legacyContextBytes
        );
        const ratchetBaseKey = await deriveConversationKey(
          dhPriv,
          theirDhPub,
          pskBytes,
          ratchetContextBytes
        );

        const myIdentityPriv = await getIdentityPrivateKey();
        let keyForEnvelope = conversationKey;
        try {
          const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
          header.rk = ratchet.headerRk;
          keyForEnvelope = ratchet.msgKey;
        } catch {
          try {
            const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
            header.rk = ratchet.headerRk;
            keyForEnvelope = ratchet.msgKey;
          } catch (error) {
            console.warn("[ratchet] send fallback to legacy", error);
          }
        }
        const envelope = await encryptEnvelope(
          keyForEnvelope,
          header,
          { type: "msg", text, clientBatchId },
          myIdentityPriv
        );
        const envelopeJson = JSON.stringify(envelope);
        const eventHash = await computeEnvelopeHash(envelope);

        await saveEvent({
          eventId: header.eventId,
          convId: header.convId,
          authorDeviceId: header.authorDeviceId,
          lamport: header.lamport,
          ts: header.ts,
          envelopeJson,
          prevHash: header.prev,
          eventHash,
        });

        await saveMessage({
          id: header.eventId,
          convId: conv.id,
          senderId: userProfile.id,
          text,
          ts: now,
          clientBatchId,
        });

        const routed = await sendCiphertext({
          convId: conv.id,
          messageId: header.eventId,
          ciphertext: envelopeJson,
          priority: "high",
          ...buildRoutingMeta(partner),
        });
        if (!routed.ok) {
          console.error("Failed to route message", routed.error);
          notifyRoutePendingToast(conv.id, routed.error);
        }

        const updatedConv: Conversation = {
          ...conv,
          lastMessage: text,
          lastTs: now,
          unread: 0,
        };

        await saveConversation(updatedConv);
        await hydrateVault();
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

    const ciphertext = await encryptJsonRecord(vk, message.id, "message", message);

    await saveMessage(message);

    const routed = await sendCiphertext({
      convId: conv.id,
      messageId: message.id,
      ciphertext,
      priority: "high",
    });
    if (!routed.ok) {
      console.error("Failed to route message", routed.error);
      notifyRoutePendingToast(conv.id, routed.error);
    }

    const updatedConv: Conversation = {
      ...conv,
      lastMessage: text,
      lastTs: message.ts,
      unread: 0,
    };

    await saveConversation(updatedConv);
    await hydrateVault();
  };

  const handleSendMedia = async (files: File[], clientBatchId: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;

    const vk = getVaultKey();
    if (!vk) return;

    const sendSingleMedia = async (file: File) => {
      if (file.size > INLINE_MEDIA_MAX_BYTES) {
        addToast({ message: "Attachment too large (max 500MB)." });
        return;
      }

      const isDirect =
        !(conv.type === "group" || conv.participants.length > 2) &&
        conv.participants.length === 2;

      if (isDirect) {
        const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
        const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

        if (partner?.dhPub && partner.identityPub) {
          const now = Date.now();
          const friendKeyId = partner.friendId ?? partner.id;
          const lamport = await nextLamportForConv(conv.id);
          const header: EnvelopeHeader = {
            v: 1 as const,
            eventId: createId(),
            convId: conv.id,
            ts: now,
            lamport,
            authorDeviceId: getOrCreateDeviceId(),
          };

          const media = await saveMessageMedia(
            header.eventId,
            file,
            INLINE_MEDIA_CHUNK_SIZE
          );
          const label = media.mime.startsWith("image/") ? "Photo" : media.name || "File";

          const dhPriv = await getDhPrivateKey();
          const theirDhPub = decodeBase64Url(partner.dhPub);
          const pskBytes = await getFriendPsk(friendKeyId);
          const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
          const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
          const conversationKey = await deriveConversationKey(
            dhPriv,
            theirDhPub,
            pskBytes,
            legacyContextBytes
          );
          const ratchetBaseKey = await deriveConversationKey(
            dhPriv,
            theirDhPub,
            pskBytes,
            ratchetContextBytes
          );

          const myIdentityPriv = await getIdentityPrivateKey();
          let keyForEnvelope = conversationKey;
          try {
            const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
            header.rk = ratchet.headerRk;
            keyForEnvelope = ratchet.msgKey;
          } catch {
            try {
              const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
              header.rk = ratchet.headerRk;
              keyForEnvelope = ratchet.msgKey;
            } catch (error) {
              console.warn("[ratchet] send fallback to legacy", error);
            }
          }
          const envelope = await encryptEnvelope(
            keyForEnvelope,
            header,
            { type: "msg", text: label, media, clientBatchId },
            myIdentityPriv
          );
          const envelopeJson = JSON.stringify(envelope);
          const eventHash = await computeEnvelopeHash(envelope);

          await saveEvent({
            eventId: header.eventId,
            convId: header.convId,
            authorDeviceId: header.authorDeviceId,
            lamport: header.lamport,
            ts: header.ts,
            envelopeJson,
            prevHash: header.prev,
            eventHash,
          });

          await saveMessage({
            id: header.eventId,
            convId: conv.id,
            senderId: userProfile.id,
            text: label,
            ts: now,
            media,
            clientBatchId,
          });

          void sendCiphertext({
            convId: conv.id,
            messageId: header.eventId,
            ciphertext: envelopeJson,
            priority: "high",
            ...buildRoutingMeta(partner),
          }).catch((error) => {
            console.error("Failed to route message", error);
          });

          const updatedConv: Conversation = {
            ...conv,
            lastMessage: label,
            lastTs: now,
            unread: 0,
          };

          await saveConversation(updatedConv);
          await hydrateVault();

          const sendChunks = async () => {
            const buffer = await file.arrayBuffer();
            const chunks = chunkBuffer(buffer, INLINE_MEDIA_CHUNK_SIZE);
            const total = chunks.length;
            for (let idx = 0; idx < chunks.length; idx += 1) {
              const chunkBody = {
                type: "media",
                phase: "chunk",
                ownerId: header.eventId,
                idx,
                total,
                mime: media.mime,
                name: media.name,
                size: media.size,
                b64: encodeBase64Url(chunks[idx]),
                clientBatchId,
              };
              await sendDirectEnvelope(conv, partner, chunkBody, "normal");
              if (idx > 0 && idx % 32 === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
            }
          };
          void sendChunks().catch((error) => {
            console.error("Failed to send media chunks", error);
          });
          return;
        }
      }

      const messageId = createId();
      const media = await saveMessageMedia(messageId, file);
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

      await saveMessage(message);

      void sendCiphertext({
        convId: conv.id,
        messageId: message.id,
        ciphertext,
        priority: "high",
      }).catch((error) => {
        console.error("Failed to route message", error);
      });

      const updatedConv: Conversation = {
        ...conv,
        lastMessage: label,
        lastTs: message.ts,
        unread: 0,
      };

      await saveConversation(updatedConv);
      await hydrateVault();
    };

    for (const file of files) {
      try {
        await sendSingleMedia(file);
      } catch (error) {
        console.error("Failed to send media", error);
        addToast({ message: "Failed to send attachment." });
      }
    }
  };

  const handleSendBatch = async (payload: { text: string; files: File[] }) => {
    const trimmed = payload.text.trim();
    const hasText = Boolean(trimmed);
    const hasFiles = payload.files.length > 0;
    if (!hasText && !hasFiles) return;
    const clientBatchId = newClientBatchId();
    if (hasText) {
      await handleSendMessage(trimmed, clientBatchId);
    }
    if (hasFiles) {
      await handleSendMedia(payload.files, clientBatchId);
    }
  };

  const handleDeleteMessages = useCallback(
    (payload: { convId: string; messageIds: string[] }) => {
      if (!payload.messageIds.length) return;
      setConfirm({
        title: "메시지 삭제",
        message:
          "이 메시지는 내 기기에서만 삭제됩니다. 삭제 후 복구할 수 없습니다. 계속할까요?",
        onConfirm: async () => {
          try {
            await deleteMessagesById(payload.messageIds);
            const messageIdSet = new Set(payload.messageIds);
            const existing = messagesByConv[payload.convId] || [];
            const remaining = existing.filter((msg) => !messageIdSet.has(msg.id));
            const updatedMessagesByConv = {
              ...messagesByConv,
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
            addToast({ message: "메시지를 삭제했습니다." });
          } catch (error) {
            console.error("Failed to delete message", error);
            addToast({ message: "메시지 삭제에 실패했습니다." });
          }
        },
      });
    },
    [addToast, convs, friends, messagesByConv, setConfirm, setData, userProfile]
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
      await putReadCursor({
        convId: conv.id,
        actorId: userProfile.id,
        cursorTs,
        anchorMsgId: payload.msgId,
      });

      const sendNow = async (targetConv: Conversation, targetCursorTs: number, anchorMsgId: string) => {
        lastReadCursorSentAtRef.current[targetConv.id] = Date.now();
        lastReadCursorSentTsRef.current[targetConv.id] = targetCursorTs;

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
    async (friend: UserProfile, ts: number) => {
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
      await saveConversation(directConv);
      return directConv;
    },
    [findDirectConvWithFriend, userProfile]
  );

  const fanoutGroupAvatarChunks = useCallback(
    async (
      groupId: string,
      sharedAvatarRef: string | undefined,
      memberIds: string[],
      options?: { allowCreateDirect?: boolean }
    ) => {
      if (!userProfile || !sharedAvatarRef) return;
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const blob = await loadAvatarFromRef(sharedAvatarRef);
      if (!blob) return;

      const buffer = await blob.arrayBuffer();
      const chunks = chunkBuffer(buffer, INLINE_MEDIA_CHUNK_SIZE);
      const total = chunks.length;
      if (!total) return;

      const targets = Array.from(new Set(memberIds)).filter(
        (id) => id && id !== userProfile.id
      );
      for (const memberId of targets) {
        const friend = friends.find((item) => item.id === memberId);
        if (!friend?.dhPub || !friend.identityPub) continue;
        let directConv = findDirectConvWithFriend(memberId) || null;
        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, Date.now());
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
                ownerId: groupId,
                idx,
                total,
                mime: blob.type || "image/png",
                b64: encodeBase64Url(chunks[idx]),
              },
              "normal"
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
      options?: { allowCreateDirect?: boolean; toastOnFailure?: boolean; sendAvatarChunks?: boolean }
    ) => {
      if (!userProfile) return;
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const toastOnFailure = options?.toastOnFailure ?? true;
      const sendAvatarChunks = options?.sendAvatarChunks ?? true;
      const targets = Array.from(new Set(memberIds)).filter((id) => id && id !== userProfile.id);
      if (!targets.length) return;

      const failures: string[] = [];
      for (const memberId of targets) {
        const friend = friends.find((item) => item.id === memberId);
        if (!friend?.dhPub || !friend.identityPub) {
          failures.push(memberId);
          continue;
        }
        let directConv = findDirectConvWithFriend(memberId) || null;
        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, event.ts);
        }
        if (!directConv) {
          failures.push(memberId);
          continue;
        }
        try {
          await sendDirectEnvelope(directConv, friend, event, "normal");
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
          allowCreateDirect,
        });
      }
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
      senderId: userProfile.id,
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

  const updateConversationOrThrow = useCallback(
    async (convId: string, updates: Partial<Conversation>) => {
      const target = useAppStore.getState().convs.find((conv) => conv.id === convId);
      if (!target) {
        throw new Error(`Conversation not found: ${convId}`);
      }
      const updated = { ...target, ...updates };
      await saveConversation(updated);
      await hydrateVault();
    },
    [hydrateVault]
  );

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
      message: "채팅을 숨겼어요.",
      actionLabel: "Undo",
      onAction: () => {
        void updateConversation(convId, { hidden: false });
      },
    });
  };

  const handleDelete = (convId: string) => {
    setConfirm({
      title: "채팅을 삭제할까요?",
      message: "삭제하면 복구할 수 없습니다.",
      onConfirm: async () => {
        await updateConversation(convId, { hidden: true });
        addToast({
          message: "채팅을 삭제했어요.",
          actionLabel: "Undo",
          onAction: () => {
            void updateConversation(convId, { hidden: false });
          },
        });
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
      addToast({ message: "채팅 열기에 실패했습니다." });
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
      addToast({ message: "프로필 열기에 실패했습니다." });
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
      addToast({ message: "친구 변경에 실패했습니다." });
    }
  };

  const updateFriendOrThrow = useCallback(
    async (friendId: string, updates: Partial<UserProfile>) => {
      const target = useAppStore.getState().friends.find((friend) => friend.id === friendId);
      if (!target) {
        throw new Error(`Friend not found: ${friendId}`);
      }
      const updated: UserProfile = {
        ...target,
        ...updates,
        updatedAt: Date.now(),
      };
      await saveProfile(updated);
      await hydrateVault();
    },
    [hydrateVault]
  );

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
      addToast({ message: "즐겨찾기 변경에 실패했습니다." });
    }
  };

  const handleFriendHide = (friendId: string) => {
    setConfirm({
      title: "Hide this friend?",
      message: "Hidden friends can be restored later from friend management.",
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
      title: "Block this friend?",
      message: "Blocking will hide their conversations.",
      onConfirm: async () => {
        try {
          await updateFriend(friendId, { friendStatus: "blocked" });
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true });
          }
        } catch (error) {
          console.error("Failed to block friend", error);
          addToast({ message: "Failed to block friend." });
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
      addToast({ message: "Failed to unblock friend." });
    }
  };

  const handleFriendDelete = (friendId: string) => {
    const target = friends.find((friend) => friend.id === friendId);
    if (!target) return;
    setConfirm({
      title: "Delete this friend?",
      message: "This removes the friend from your list. You can re-add them later.",
      onConfirm: async () => {
        try {
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true });
          }
          const pskKeyId = target.friendId ?? target.id;
          await clearFriendPsk(pskKeyId);
          await deleteProfile(friendId);
          await hydrateVault();
        } catch (error) {
          console.error("Failed to delete friend", error);
          addToast({ message: "Failed to delete friend." });
        }
      },
    });
  };

  const handleCopyFriendCode = async () => {
    try {
      if (!myFriendCode) return;
      await navigator.clipboard.writeText(myFriendCode);
      addToast({ message: "친구 코드가 복사되었습니다." });
    } catch (error) {
      console.error("Failed to copy friend code", error);
      addToast({ message: "친구 코드 복사에 실패했습니다." });
    }
  };
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
      title: "Leave this group?",
      message: "You will stop seeing new messages from this group.",
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
          addToast({ message: "Failed to leave group." });
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
        addToast({ message: "Failed to update local group image." });
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
      await fanoutGroupEvent(conv.participants, groupEvent, {
        allowCreateDirect: true,
        toastOnFailure: false,
      });
      await hydrateVault();

      setSelectedConv(conv.id);
      setListMode("chats");
      setListFilter("all");

      return { ok: true as const };
    } catch (error) {
      console.error("Failed to create group", error);
      return { ok: false as const, error: "Failed to create group." };
    }
  };

  const handleAddFriend = async (payload: { code: string; psk?: string }) => {
    const failWithTestLog = (
      error: string,
      stage: string,
      extras?: Omit<FriendAddTestLog, "result" | "stage" | "message">
    ) => {
      emitFriendAddTestLog({
        result: "not_added",
        stage,
        message: error,
        ...extras,
      });
      return { ok: false as const, error };
    };

    if (!userProfile) {
      return failWithTestLog("User profile missing.", "guard:user-profile-missing");
    }

    const rawInput = payload.code.trim();
    const normalized = normalizeInviteCode(rawInput);
    const prefixProbe = normalized.replace(/[^A-Z0-9]/g, "");
    let attemptKey = normalized || "empty";
    let inviteFingerprint: string | null = null;
    let invitePsk: Uint8Array | null = null;
    let oneTimeInvite = false;

    if (prefixProbe.startsWith("NCK") || (prefixProbe.startsWith("NKC") && !prefixProbe.startsWith("NKC1"))) {
      recordFail(attemptKey);
      return failWithTestLog(
        "레거시 친구 ID(NCK-/NKC-)는 더 이상 지원하지 않습니다. 상대에게 NKC1- 친구 코드를 요청하세요.",
        "guard:legacy-code"
      );
    }

    if (prefixProbe.startsWith("NKI1")) {
      try {
        inviteFingerprint = await computeInviteFingerprint(normalized);
        attemptKey = `invite:${inviteFingerprint}`;
      } catch {
        return failWithTestLog("Invite code invalid.", "guard:invite-fingerprint-invalid");
      }
    }

    const firstGate = checkAllowed(attemptKey);
    if (!firstGate.ok) {
      const waitSeconds = Math.ceil((firstGate.waitMs ?? 0) / 1000);
      return failWithTestLog(
        `Too many attempts. Try again in ${waitSeconds}s.`,
        "guard:rate-limit-initial"
      );
    }

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
      try {
        invitePsk = decodeBase64Url(decodedInvite.psk);
      } catch {
        recordFail(attemptKey);
        return failWithTestLog("Invalid invite PSK.", "decode:invite-psk-invalid");
      }
      friendCode = encodeFriendCodeV1(decodedInvite.friend);
    }

    const decoded = decodeFriendCodeV1(friendCode);
    if ("error" in decoded) {
      recordFail(attemptKey);
      return failWithTestLog(decoded.error, "decode:friend-code-invalid");
    }

    const identityPubBytes = decodeBase64Url(decoded.identityPub);
    const friendId = computeFriendId(identityPubBytes);
    const finalKey = prefixProbe.startsWith("NKI1") ? attemptKey : `friend:${friendId}`;
    if (finalKey !== attemptKey) {
      const gate = checkAllowed(finalKey);
      if (!gate.ok) {
        const waitSeconds = Math.ceil((gate.waitMs ?? 0) / 1000);
        return failWithTestLog(
          `Too many attempts. Try again in ${waitSeconds}s.`,
          "guard:rate-limit-friend-id",
          { friendId }
        );
      }
    }

    try {
      const myIdentityPub = await getIdentityPublicKey();
      if (encodeBase64Url(myIdentityPub) === decoded.identityPub) {
        recordFail(finalKey);
        return failWithTestLog("You cannot add yourself.", "guard:self-add", { friendId });
      }
    } catch {
      // Best-effort self-check only; continue.
    }

    const finalizeFriendAdd = async () => {
      try {
        const existing = friends.find(
          (friend) => friend.friendId === friendId || friend.identityPub === decoded.identityPub
        );

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
            });
            await hydrateVault();
          }
          recordFail(finalKey);
          return failWithTestLog("Friend keys changed; blocked.", "verify:tofu-blocked", {
            profileId: existing?.id,
            friendId,
          });
        }

        const psk =
          invitePsk ?? (payload.psk?.trim() ? new TextEncoder().encode(payload.psk.trim()) : null);
        if (psk) {
          await setFriendPsk(friendId, psk);
        }

        const routingHints = sanitizeRoutingHints(
          decoded.onionAddr || decoded.lokinetAddr || decoded.deviceId
            ? {
                onionAddr: decoded.onionAddr,
                lokinetAddr: decoded.lokinetAddr,
                deviceId: decoded.deviceId,
              }
            : undefined
        );
        if (!decoded.deviceId) {
          console.warn("[friend] missing deviceId in friend code; marking unreachable", {
            friendId,
          });
        }

        const short = friendId.slice(0, 6);
        const reachability = (() => {
          if (decoded.deviceId) {
            return {
              status: "ok" as const,
              attempts: existing?.reachability?.attempts ?? 0,
              lastAttemptAt: existing?.reachability?.lastAttemptAt,
              nextAttemptAt: existing?.reachability?.nextAttemptAt,
            };
          }
          return {
            status: "unreachable" as const,
            lastError: "Missing deviceId in friend code",
            attempts: existing?.reachability?.attempts ?? 0,
            lastAttemptAt: Date.now(),
            nextAttemptAt: existing?.reachability?.nextAttemptAt,
          };
        })();

        const friend: UserProfile = {
          id: existing?.id ?? createId(),
          friendId,
          displayName: existing?.displayName ?? (short ? `Friend ${short}` : "Friend"),
          status: existing?.status ?? "Friend",
          theme: existing?.theme ?? "dark",
          kind: "friend",
          friendStatus: existing?.friendStatus ?? "request_out",
          isFavorite: existing?.isFavorite ?? false,
          identityPub: decoded.identityPub,
          dhPub: decoded.dhPub,
          routingHints,
          primaryDeviceId: decoded.deviceId ?? existing?.primaryDeviceId,
          trust: { pinnedAt: existing?.trust?.pinnedAt ?? now, status: "trusted" },
          verification: existing?.verification ?? { status: "unverified" },
          reachability,
          pskHint: Boolean(psk) || existing?.pskHint,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        await saveProfile(friend);

        let requestSent = false;
        try {
          requestSent = await sendFriendRequestForFriend(friend);
        } catch (error) {
          console.warn("[friend] failed to send friend request", error);
        }
        if (!requestSent) {
          await hydrateVault();
          const hasDeviceId = Boolean(
            friend.routingHints?.deviceId || friend.primaryDeviceId || friend.deviceId
          );
          if (!hasDeviceId) {
            addToast({
              message:
                "친구는 추가되었지만 코드에 기기 ID가 없어 요청을 보낼 수 없습니다. 상대가 최신 버전에서 코드를 다시 복사해 보내야 합니다.",
            });
            emitFriendAddTestLog({
              result: "added",
              stage: "result:added-missing-device-id",
              message: "Friend added without deviceId; friend request not sent.",
              profileId: friend.id,
              friendId,
              requestSent: false,
            });
            return {
              ok: true as const,
            };
          }
          addToast({
            message:
              "친구를 목록에 추가했습니다. 요청 전송이 지연되어 백그라운드에서 재시도됩니다.",
          });
          emitFriendAddTestLog({
            result: "added",
            stage: "result:added-request-delayed",
            message: "Friend added; request send delayed and scheduled for retry.",
            profileId: friend.id,
            friendId,
            requestSent: false,
          });
          return {
            ok: true as const,
          };
        }

        await hydrateVault();
        devLog("friend:add:success", { id: friend.id, friendId });
        emitFriendAddTestLog({
          result: "added",
          stage: "result:added-request-sent",
          message: "Friend added and request sent.",
          profileId: friend.id,
          friendId,
          requestSent: true,
        });

        recordSuccess(finalKey);
        return { ok: true as const };
      } catch (error) {
        console.error("Friend:add failed", error);
        recordFail(finalKey);
        return failWithTestLog("Failed to add friend.", "exception:add-failed", { friendId });
      }
    };

    if (oneTimeInvite && inviteFingerprint) {
      const guarded = await runOneTimeInviteGuard(
        inviteFingerprint,
        finalizeFriendAdd,
        (result) => result.ok
      );
      if (!guarded.ok) {
        recordFail(finalKey);
        return failWithTestLog("Invite already used.", "guard:invite-already-used", { friendId });
      }
      return guarded.value;
    }

    return finalizeFriendAdd();
  };

  const currentConversation = ui.selectedConvId
    ? convs.find((conv) => conv.id === ui.selectedConvId) || null
    : null;
  const currentMessages = currentConversation ? messagesByConv[currentConversation.id] || [] : [];
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
      void disconnectSyncConversation(prev);
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
      lokinetAddr: partner.routingHints?.lokinetAddr,
    });
    activeSyncConvRef.current = conv.id;
  }, [ui.selectedConvId, convs, friends, userProfile]);

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
      response: PendingFriendResponseType
    ): Promise<{ ok: true } | { ok: false; reason: "missing-device" | "send-failed" }> => {
      if (!partner.routingHints?.deviceId && !partner.primaryDeviceId && !partner.deviceId) {
        return { ok: false, reason: "missing-device" };
      }
      const [identityPub, dhPub] = await Promise.all([getIdentityPublicKey(), getDhPublicKey()]);
      const payload =
        response === "accept"
          ? {
              type: "friend_accept" as const,
              convId: conv.id,
              from: {
                identityPub: encodeBase64Url(identityPub),
                dhPub: encodeBase64Url(dhPub),
                deviceId: getOrCreateDeviceId(),
              },
              profile: {
                displayName: userProfile?.displayName,
                status: userProfile?.status,
                avatarRef: userProfile?.avatarRef,
              },
              ts: Date.now(),
            }
          : {
              type: "friend_decline" as const,
              convId: conv.id,
              from: {
                identityPub: encodeBase64Url(identityPub),
                dhPub: encodeBase64Url(dhPub),
                deviceId: getOrCreateDeviceId(),
              },
              ts: Date.now(),
            };
      const sent = await sendFriendControlPacket(conv, partner, payload);
      return sent ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    [sendFriendControlPacket, userProfile?.avatarRef, userProfile?.displayName, userProfile?.status]
  );

  const applyFriendResponseLocally = useCallback(
    async (convId: string, friendId: string, response: PendingFriendResponseType) => {
      if (response === "accept") {
        await updateFriendOrThrow(friendId, { friendStatus: "normal" });
        await updateConversationOrThrow(convId, {
          hidden: false,
          pendingAcceptance: false,
          pendingOutgoing: false,
          pendingFriendResponse: undefined,
        });
        return;
      }
      await updateFriendOrThrow(friendId, { friendStatus: "blocked" });
      await updateConversationOrThrow(convId, {
        hidden: true,
        pendingAcceptance: false,
        pendingOutgoing: false,
        pendingFriendResponse: undefined,
      });
    },
    [updateConversationOrThrow, updateFriendOrThrow]
  );

  const handleAcceptRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    try {
      const outcome = await sendFriendResponseControl(currentConversation, partnerProfile, "accept");
      if (!outcome.ok) {
        await updateConversationOrThrow(currentConversation.id, {
          pendingFriendResponse: "accept",
        });
        addToast({
          message:
            outcome.reason === "missing-device"
              ? "상대 기기 정보가 없어 수락 전송이 지연됩니다. 정보가 갱신되면 자동 재시도합니다."
              : "수락 전송이 지연되었습니다. 백그라운드에서 자동 재시도합니다.",
        });
        return;
      }
      await applyFriendResponseLocally(currentConversation.id, partnerProfile.id, "accept");
    } catch (error) {
      console.error("Failed to accept request", error);
      addToast({ message: "메시지 요청 수락에 실패했습니다." });
    }
  };

  useEffect(() => {
    if (!userProfile) return;
    const scheduler = startFriendRequestScheduler({
      getTargets: () => useAppStore.getState().friends,
      onAttempt: async (friend) => {
        try {
          return await sendFriendRequestForFriend(friend);
        } catch (error) {
          console.warn("[friend] request retry failed", error);
          return false;
        }
      },
      onUpdate: async (friendId, patch) => {
        const latest = useAppStore.getState().friends.find((item) => item.id === friendId);
        if (!latest) return;
        await saveProfile({
          ...latest,
          ...patch,
          updatedAt: Date.now(),
        });
        await hydrateVault();
      },
    });
    return () => scheduler.stop();
  }, [hydrateVault, sendFriendRequestForFriend, userProfile]);

  useEffect(() => {
    if (!userProfile) return;
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
          return [{ convId: conv.id, friendId: partner.id, response: pending }];
        });
      },
      onAttempt: async (target) => {
        const state = useAppStore.getState();
        const conv = state.convs.find((item) => item.id === target.convId);
        const partner = state.friends.find((item) => item.id === target.friendId);
        if (!conv || !partner) return false;
        try {
          const outcome = await sendFriendResponseControl(conv, partner, target.response);
          if (!outcome.ok) return false;
          await applyFriendResponseLocally(conv.id, partner.id, target.response);
          return true;
        } catch (error) {
          console.warn("[friend] response retry failed", error);
          return false;
        }
      },
    });
    return () => scheduler.stop();
  }, [applyFriendResponseLocally, sendFriendResponseControl, userProfile]);

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
    try {
      const outcome = await sendFriendResponseControl(currentConversation, partnerProfile, "decline");
      if (!outcome.ok) {
        await updateConversationOrThrow(currentConversation.id, {
          pendingFriendResponse: "decline",
        });
        addToast({
          message:
            outcome.reason === "missing-device"
              ? "상대 기기 정보가 없어 거절 전송이 지연됩니다. 정보가 갱신되면 자동 재시도합니다."
              : "거절 전송이 지연되었습니다. 백그라운드에서 자동 재시도합니다.",
        });
        return;
      }
      await applyFriendResponseLocally(currentConversation.id, partnerProfile.id, "decline");
    } catch (error) {
      console.error("Failed to decline request", error);
      addToast({ message: "메시지 요청 거절에 실패했습니다." });
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
    <div className="flex h-full gap-6 bg-nkc-bg p-6">
      <Sidebar
        convs={convs}
        friends={friends}
        userId={userProfile?.id || null}
        userProfile={userProfile}
        groupAvatarRefsByConv={groupAvatarRefsByConv}
        friendAliasesById={friendAliasesById}
        selectedConvId={ui.selectedConvId}
        listMode={ui.listMode}
        listFilter={ui.listFilter}
        search={ui.search}
        onSearch={setSearch}
        onSelectConv={handleSelectConv}
        onAddFriend={() => setFriendAddOpen(true)}
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
        onSettings={() => navigate("/settings")}
        onLock={handleLock}
        onHide={handleHide}
        onDelete={handleDelete}
        onTogglePin={handleTogglePin}
        onMute={handleMute}
        onBlock={handleBlock}
      />

      <ChatView
        key={currentConversation?.id ?? "none"}
        conversation={currentConversation}
        conversationDisplayName={currentConversationDisplayName}
        transportStatus={currentTransportStatus}
        messages={currentMessages}
        currentUserId={userProfile?.id || null}
        nameMap={nameMap}
        profilesById={profilesById}
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSendBatch={handleSendBatch}
        onSendReadReceipt={handleSendReadReceipt}
        onAcceptRequest={handleAcceptRequest}
        onDeclineRequest={handleDeclineRequest}
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

      {userProfile ? (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open) navigate("/");
          }}
          user={userProfile}
          onSaveProfile={handleSaveProfile}
          onUploadPhoto={handleUploadPhoto}
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
              title: "로그아웃할까요?",
              message: "세션을 종료하고 로컬 데이터는 유지됩니다.",
              onConfirm: handleLogout,
            })
          }
          onWipe={() =>
            setConfirm({
              title: "데이터를 삭제할까요?",
              message: "로컬 금고가 초기화됩니다.",
              onConfirm: async () => {
                await clearStoredSession();
                await wipePinState();
                await wipeVault();
                window.location.reload();
              },
            })
          }
        />
      ) : null}

      {userProfile ? (
        <FriendAddDialog
          open={friendAddOpen}
          onOpenChange={setFriendAddOpen}
          myCode={myFriendCode}
          onCopyCode={handleCopyFriendCode}
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
                onDone={() => navigate("/settings")}
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











