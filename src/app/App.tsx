import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock from "../components/Unlock";
import StartKey from "../components/StartKey";
import FriendAddDialog from "../components/FriendAddDialog";
import GroupCreateDialog from "../components/GroupCreateDialog";
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
  nextLamportForConv,
  getLastEventHash,
  saveConversation,
  saveEvent,
  saveMessage,
  saveMessageMedia,
  saveProfile,
  saveProfilePhoto,
  seedVaultData,
  unlockVault,
  wipeVault,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { chunkBuffer, encryptJsonRecord, validateStartKey } from "../crypto/vault";
import { getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import { computeFriendId, decodeFriendCodeV1, encodeFriendCodeV1 } from "../security/friendCode";
import { decodeInviteCodeV1 } from "../security/inviteCode";
import { isInviteUsed, markInviteUsed } from "../security/inviteUseStore";
import { checkAllowed, recordFail, recordSuccess } from "../security/rateLimit";
import { applyTOFU } from "../security/trust";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { clearPin, clearPinRecord, getPinStatus, isPinUnavailableError, setPin as savePin, verifyPin } from "../security/pin";
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
import { syncGroupCreate } from "../sync/groupSync";
import {
  connectConversation as connectSyncConversation,
  disconnectConversation as disconnectSyncConversation,
} from "../sync/syncEngine";
import {
  getTransportStatus,
  onTransportStatusChange,
  setDirectApprovalHandler,
  type ConversationTransportStatus,
} from "../net/transportManager";

const buildNameMap = (profiles: UserProfile[]) =>
  profiles.reduce<Record<string, string>>((acc, profile) => {
    acc[profile.id] = profile.displayName;
    return acc;
  }, {});

const INLINE_MEDIA_MAX_BYTES = 2 * 1024 * 1024;
const INLINE_MEDIA_CHUNK_SIZE = 48 * 1024;

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
  const [myFriendCode, setMyFriendCode] = useState("");
  const [transportStatusByConv, setTransportStatusByConv] = useState<
    Record<string, ConversationTransportStatus>
  >({});
  const [directApprovalOpen, setDirectApprovalOpen] = useState(false);
  const directApprovalResolveRef = useRef<((approved: boolean) => void) | null>(null);

  const onboardingLockRef = useRef(false);
  const bootGuardRef = useRef<Promise<void> | null>(null);
  const outboxSchedulerStarted = useRef(false);
  const activeSyncConvRef = useRef<string | null>(null);

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

  const settingsOpen = location.pathname === "/settings";
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

  useEffect(() => {
    if (!friendAddOpen || !userProfile) return;
    Promise.all([getIdentityPublicKey(), getDhPublicKey()])
      .then(([identityPub, dhPub]) =>
        encodeFriendCodeV1({
          v: 1,
          identityPub: encodeBase64Url(identityPub),
          dhPub: encodeBase64Url(dhPub),
        })
      )
      .then(setMyFriendCode)
      .catch((error) => console.error("Failed to compute friend code", error));
  }, [friendAddOpen, userProfile]);

  const resolveDirectApproval = useCallback((approved: boolean) => {
    const resolver = directApprovalResolveRef.current;
    if (resolver) {
      resolver(approved);
    }
    directApprovalResolveRef.current = null;
    setDirectApprovalOpen(false);
  }, []);

  const requestDirectApproval = useCallback(async () => {
    if (directApprovalResolveRef.current) return false;
    return new Promise<boolean>((resolve) => {
      directApprovalResolveRef.current = resolve;
      setDirectApprovalOpen(true);
    });
  }, []);

  useEffect(() => {
    setDirectApprovalHandler(requestDirectApproval);
    return () => {
      setDirectApprovalHandler(null);
    };
  }, [requestDirectApproval]);

  useEffect(() => {
    const unsubscribe = onTransportStatusChange((convId, status) => {
      setTransportStatusByConv((prev) => ({ ...prev, [convId]: status }));
    });
    return () => {
      unsubscribe();
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

  // cleanup 타입 문제(EffectCallback) + unsubscribe 방어
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

  const handlePinUnlock = async (pin: string) => {
    const result = await verifyPin(pin);

    if (!result.ok) {
      if (result.reason === "unavailable") {
        return {
          ok: false,
          error: result.message || "PIN lock is unavailable on this platform/build.",
        };
      }
      if (result.reason === "not_set") {
        await clearPinRecord();
        setPinEnabled(true);
        setPinNeedsReset(true);
        setDefaultTab("startKey");
        setMode("onboarding");
        navigate("/");
        return { ok: false, error: "PIN must be reset. Unlock with the start key." };
      }

      return {
        ok: false,
        error: result.reason === "locked" ? "Please try again later." : "PIN is incorrect.",
        retryAfterMs: result.retryAfterMs,
      };
    }

    try {
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
      return { ok: false, error: "Unlock failed." };
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
      setPinEnabled(false);
      setPinNeedsReset(false);
      addToast({ message: "PIN disabled." });
    } catch (error) {
      if (isPinUnavailableError(error)) {
        addToast({ message: "PIN lock is unavailable on this platform/build." });
        return;
      }
      console.error("Failed to clear PIN", error);
      addToast({ message: "Failed to disable PIN." });
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


  const buildRoutingMeta = (partner: UserProfile) => ({
    toDeviceId: partner.friendId ?? partner.id,
    route: {
      torOnion: partner.routingHints?.onionAddr,
      lokinet: partner.routingHints?.lokinetAddr,
    },
  });

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

      void sendCiphertext({
        convId: conv.id,
        messageId: header.eventId,
        ciphertext: envelopeJson,
        priority,
        ...buildRoutingMeta(partner),
      }).catch((error) => {
        console.error("Failed to route message", error);
      });

      return { header, envelopeJson };
    },
    []
  );

  const handleSendMessage = async (text: string) => {
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
          { type: "msg", text },
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
      lastMessage: text,
      lastTs: message.ts,
      unread: 0,
    };

    await saveConversation(updatedConv);
    await hydrateVault();
  };

  const handleSendMedia = async (file: File) => {
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
        const inlineAllowed = file.size <= INLINE_MEDIA_MAX_BYTES;
        if (!inlineAllowed) {
          addToast({ message: "Attachment too large for inline transfer (MVP limit 2MB)." });
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

        const media = inlineAllowed
          ? await saveMessageMedia(header.eventId, file, INLINE_MEDIA_CHUNK_SIZE)
          : await saveMessageMedia(header.eventId, file);
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
          { type: "msg", text: label, media },
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

        if (inlineAllowed) {
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
              };
              await sendDirectEnvelope(conv, partner, chunkBody, "normal");
            }
          };
          void sendChunks().catch((error) => {
            console.error("Failed to send media chunks", error);
          });
        }
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

  const handleSendReadReceipt = useCallback(
    async (payload: { convId: string; msgId: string }) => {
      if (!userProfile) return;
      const conv = convs.find((item) => item.id === payload.convId);
      if (!conv) return;
      const isDirect =
        !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;
      if (!isDirect) return;

      const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
      const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;
      if (!partner?.dhPub || !partner.identityPub) return;

      try {
        await sendDirectEnvelope(
          conv,
          partner,
          { type: "rcpt", kind: "read", msgId: payload.msgId, convId: conv.id, ts: Date.now() },
          "normal"
        );
      } catch (error) {
        console.error("Failed to send read receipt", error);
      }
    },
    [convs, friends, userProfile, sendDirectEnvelope]
  );

  const findDirectConvWithFriend = (friendId: string) =>
    convs.find(
      (conv) => !(conv.type === "group" || conv.participants.length > 2) && conv.participants.includes(friendId)
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

  const normalizeInviteCode = (value: string) =>
    value.trim().replace(/\s+/g, "").toUpperCase();

  const computeInviteFingerprint = async (normalized: string) => {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Crypto subtle is unavailable.");
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

  const handleSubmitGroup = async (payload: { name: string; memberIds: string[] }) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };

    const members = Array.from(new Set(payload.memberIds)).filter((id) => id && id !== userProfile.id);
    if (!members.length) return { ok: false as const, error: "Select at least one friend." };

    try {
      const now = Date.now();
      const convId = createId();

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
      };

      await saveConversation(conv);

      await saveMessage({
        id: createId(),
        convId: conv.id,
        senderId: userProfile.id,
        text: "Group created",
        ts: now,
      });

      await syncGroupCreate({ id: conv.id, name: conv.name, memberIds: conv.participants });
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

  const handleAddFriendLegacy = async (rawId: string) => {
    const trimmed = rawId.trim();

    if (!trimmed) {
      return { ok: false as const, error: "Enter a friend ID." };
    }
    if (!trimmed.startsWith("NCK-")) {
      return { ok: false as const, error: "Enter a valid friend ID." };
    }
    if (friends.some((friend) => friend.friendId === trimmed)) {
      return { ok: false as const, error: "Friend already added." };
    }

    try {
      const now = Date.now();
      const short = trimmed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);

      const friend: UserProfile = {
        id: createId(),
        friendId: trimmed,
        displayName: short ? `Friend ${short}` : "Friend",
        status: "Friend",
        theme: "dark",
        kind: "friend",
        friendStatus: "request_out",
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
      };

      await saveProfile(friend);
      await hydrateVault();
      devLog("friend:add:success", { id: friend.id });

      return { ok: true as const };
    } catch (error) {
      console.error("Friend:add failed", error);
      return { ok: false as const, error: "Failed to add friend." };
    }
  };

  const handleAddFriend = async (payload: { code: string; psk?: string }) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };

    const rawInput = payload.code.trim();
    const normalized = normalizeInviteCode(rawInput);
    let attemptKey = normalized || "empty";
    let inviteFingerprint: string | null = null;
    let invitePsk: Uint8Array | null = null;
    let oneTimeInvite = false;

    if (normalized.startsWith("NKI1")) {
      try {
        inviteFingerprint = await computeInviteFingerprint(normalized);
        attemptKey = `invite:${inviteFingerprint}`;
      } catch {
        return { ok: false as const, error: "Invite code invalid." };
      }
    }

    const firstGate = checkAllowed(attemptKey);
    if (!firstGate.ok) {
      const waitSeconds = Math.ceil((firstGate.waitMs ?? 0) / 1000);
      return {
        ok: false as const,
        error: `Too many attempts. Try again in ${waitSeconds}s.`,
      };
    }

    if (rawInput.startsWith("NCK-")) {
      const legacy = await handleAddFriendLegacy(rawInput);
      if (legacy.ok) {
        recordSuccess(attemptKey);
      } else {
        recordFail(attemptKey);
      }
      return legacy;
    }

    let friendCode = rawInput;
    if (normalized.startsWith("NKI1")) {
      const decodedInvite = decodeInviteCodeV1(rawInput);
      if ("error" in decodedInvite) {
        recordFail(attemptKey);
        if (decodedInvite.error.toLowerCase().includes("expired")) {
          return { ok: false as const, error: "Invite expired." };
        }
        return { ok: false as const, error: decodedInvite.error };
      }
      oneTimeInvite = Boolean(decodedInvite.oneTime);
      if (oneTimeInvite && inviteFingerprint) {
        if (await isInviteUsed(inviteFingerprint)) {
          recordFail(attemptKey);
          return { ok: false as const, error: "Invite already used." };
        }
      }
      try {
        invitePsk = decodeBase64Url(decodedInvite.psk);
      } catch {
        recordFail(attemptKey);
        return { ok: false as const, error: "Invalid invite PSK." };
      }
      friendCode = encodeFriendCodeV1(decodedInvite.friend);
    }

    const decoded = decodeFriendCodeV1(friendCode);
    if ("error" in decoded) {
      recordFail(attemptKey);
      return { ok: false as const, error: decoded.error };
    }

    const identityPubBytes = decodeBase64Url(decoded.identityPub);
    const friendId = computeFriendId(identityPubBytes);
    const finalKey = normalized.startsWith("NKI1") ? attemptKey : `friend:${friendId}`;
    if (finalKey !== attemptKey) {
      const gate = checkAllowed(finalKey);
      if (!gate.ok) {
        const waitSeconds = Math.ceil((gate.waitMs ?? 0) / 1000);
        return {
          ok: false as const,
          error: `Too many attempts. Try again in ${waitSeconds}s.`,
        };
      }
    }

    try {
      const myIdentityPub = await getIdentityPublicKey();
      if (encodeBase64Url(myIdentityPub) === decoded.identityPub) {
        recordFail(finalKey);
        return { ok: false as const, error: "You cannot add yourself." };
      }
    } catch {
      // Best-effort self-check only; continue.
    }

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
        return { ok: false as const, error: "Friend keys changed; blocked." };
      }

      const psk =
        invitePsk ?? (payload.psk?.trim() ? new TextEncoder().encode(payload.psk.trim()) : null);
      if (psk) {
        await setFriendPsk(friendId, psk);
      }

      const routingHints = sanitizeRoutingHints(
        decoded.onionAddr || decoded.lokinetAddr
          ? { onionAddr: decoded.onionAddr, lokinetAddr: decoded.lokinetAddr }
          : undefined
      );

      const short = friendId.slice(0, 6);
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
        trust: { pinnedAt: existing?.trust?.pinnedAt ?? now, status: "trusted" },
        pskHint: Boolean(psk) || existing?.pskHint,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await saveProfile(friend);
      await hydrateVault();
      devLog("friend:add:success", { id: friend.id, friendId });

      if (oneTimeInvite && inviteFingerprint) {
        await markInviteUsed(inviteFingerprint);
      }

      recordSuccess(finalKey);
      return { ok: true as const };
    } catch (error) {
      console.error("Friend:add failed", error);
      recordFail(finalKey);
      return { ok: false as const, error: "Failed to add friend." };
    }
  };

  const currentConversation = ui.selectedConvId
    ? convs.find((conv) => conv.id === ui.selectedConvId) || null
    : null;
  const currentMessages = currentConversation ? messagesByConv[currentConversation.id] || [] : [];
  const currentTransportStatus = currentConversation
    ? transportStatusByConv[currentConversation.id] ??
      getTransportStatus(currentConversation.id)
    : null;

  const nameMap = useMemo(
    () => buildNameMap([...(friends || []), ...(userProfile ? [userProfile] : [])]),
    [friends, userProfile]
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
    const partnerId = currentConversation.participants.find((id) => id !== userProfile?.id);
    return friends.find((friend) => friend.id === partnerId) || null;
  }, [currentConversation, friends, userProfile]);

  const handleAcceptRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    try {
      await updateFriend(partnerProfile.id, { friendStatus: "normal" });
      await updateConversation(currentConversation.id, { hidden: false, pendingAcceptance: false });
    } catch (error) {
      console.error("Failed to accept request", error);
      addToast({ message: "메시지 요청 수락에 실패했습니다." });
    }
  };

  const handleDeclineRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    try {
      await updateFriend(partnerProfile.id, { friendStatus: "blocked" });
      await updateConversation(currentConversation.id, {
        hidden: true,
        pendingAcceptance: false,
      });
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
        conversation={currentConversation}
        transportStatus={currentTransportStatus}
        messages={currentMessages}
        currentUserId={userProfile?.id || null}
        nameMap={nameMap}
        profilesById={profilesById}
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSend={handleSendMessage}
        onSendMedia={handleSendMedia}
        onSendReadReceipt={handleSendReadReceipt}
        onAcceptRequest={handleAcceptRequest}
        onDeclineRequest={handleDeclineRequest}
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
        onOpenSettings={() => navigate("/settings")}
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
          element={ui.mode === "locked" ? <Unlock onUnlock={handlePinUnlock} /> : <Navigate to="/" replace />}
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
          // confirm?.onConfirm()이 Promise를 반환해도 UI는 void 처리
          void confirm?.onConfirm?.();
        }}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={directApprovalOpen}
        title="Direct 연결 허용"
        message="Direct 연결은 상대방에게 IP가 노출될 수 있습니다. 허용할까요?"
        onConfirm={() => resolveDirectApproval(true)}
        onClose={() => resolveDirectApproval(false)}
      />

      <Toasts />
    </>
  );
}


