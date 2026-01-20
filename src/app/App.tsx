import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock from "../components/Unlock";
import Recovery from "../components/Recovery";
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
  listMessagesByConv,
  listProfiles,
  lockVault,
  verifyVaultKeyId,
  rotateVaultKeys,
  deleteProfile,
  saveConversation,
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
import { encryptJsonRecord, validateRecoveryKey } from "../crypto/vault";
import { getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import { getShareId } from "../security/friendId";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { clearPin, clearPinRecord, getPinStatus, isPinUnavailableError, setPin as savePin, verifyPin } from "../security/pin";
import { sendCiphertext } from "../net/router";
import { startOutboxScheduler } from "../net/outboxScheduler";
import { onConnectionStatus } from "../net/connectionStatus";
import { syncGroupCreate } from "../sync/groupSync";

const buildNameMap = (profiles: UserProfile[]) =>
  profiles.reduce<Record<string, string>>((acc, profile) => {
    acc[profile.id] = profile.displayName;
    return acc;
  }, {});

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
  const [defaultTab, setDefaultTab] = useState<"create" | "import">("create");
  const [pinNeedsReset, setPinNeedsReset] = useState(false);
  const wasHiddenRef = useRef(false);

  const [onboardingError, setOnboardingError] = useState("");
  const [friendAddOpen, setFriendAddOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [shareId, setShareId] = useState("");

  const onboardingLockRef = useRef(false);
  const outboxSchedulerStarted = useRef(false);

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
    getShareId(userProfile.id)
      .then(setShareId)
      .catch((error) => console.error("Failed to derive share ID", error));
  }, [friendAddOpen, userProfile]);

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
        if (!keyOk) throw new Error("Vault key mismatch");
      }

      const profiles = await withTimeout(listProfiles(), "listProfiles");
      const user = profiles.find((profile) => profile.kind === "user") || null;
      const friendProfiles = profiles.filter((profile) => profile.kind === "friend");

      const conversations = await withTimeout(listConversations(), "listConversations");
      const messagesBy: Record<string, Message[]> = {};

      for (const conv of conversations) {
        messagesBy[conv.id] = await withTimeout(listMessagesByConv(conv.id), "listMessagesByConv");
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
          addToast({ message: "PIN must be reset. Unlock with the recovery key." });
        }
        setDefaultTab("import");
        setMode("onboarding");
      }

      addToast({ message: "세션이 만료되었습니다. 다시 로그인해 주세요." });
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

        const session = await getStoredSession();
        if (session?.vaultKey) {
          setVaultKey(session.vaultKey);
          await setStoredSession(session.vaultKey);
          await hydrateVault();
          return;
        }

        if (pinStatus.enabled && !pinStatus.needsReset) {
          setMode("locked");
        } else {
          if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the recovery key." });
          }
          setDefaultTab("import");
          setMode("onboarding");
        }
      } catch (error) {
        console.error("Boot failed", error);
        addToast({ message: "앱 초기화에 실패했습니다." });
        setMode("onboarding");
      }
    };

    void boot();

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

  // ✅ cleanup 타입 문제(EffectCallback) + unsubscribe 타입 방어
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

      const now = Date.now();
      const user: UserProfile = {
        id: createId(),
        displayName,
        status: "NKC에서 안녕하세요",
        theme: "dark",
        kind: "user",
        createdAt: now,
        updatedAt: now,
      };

      await withTimeout(seedVaultData(user), "seedVaultData");
      await withTimeout(setStoredSession(vk), "setStoredSession");
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

  const handleImport = async (recoveryKey: string, displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;

    if (!validateRecoveryKey(recoveryKey)) {
      addToast({ message: "???? ?? ?? ? ?????. (?: NKC-...)" });
      onboardingLockRef.current = false;
      return;
    }

    try {
      devLog("onboarding:import:start");

      await withTimeout(unlockVault(recoveryKey), "unlockVault");

      const vk = getVaultKey();
      if (!vk) throw new Error("Vault key missing after unlock.");

      const profiles = await withTimeout(listProfiles(), "listProfiles");
      if (!profiles.length) {
        const now = Date.now();
        const user: UserProfile = {
          id: createId(),
          displayName: displayName || "NKC 사용자",
          status: "NKC에서 안녕하세요",
          theme: "dark",
          kind: "user",
          createdAt: now,
          updatedAt: now,
        };
        await withTimeout(seedVaultData(user), "seedVaultData");
      }

      await withTimeout(setStoredSession(vk), "setStoredSession");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Recovery import failed", error);
      lockVault();
      addToast({ message: "복구키로 가져오기에 실패했습니다." });
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
        setDefaultTab("import");
        setMode("onboarding");
        navigate("/");
        return { ok: false, error: "PIN must be reset. Unlock with the recovery key." };
      }

      return {
        ok: false,
        error: result.reason === "locked" ? "Please try again later." : "PIN is incorrect.",
        retryAfterMs: result.retryAfterMs,
      };
    }

    try {
      setVaultKey(result.vaultKey);
      await setStoredSession(result.vaultKey);
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
    if (!pinEnabled || pinNeedsReset) {
      if (pinNeedsReset) {
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
  }, [addToast, navigate, pinEnabled, pinNeedsReset, resetAppState, setMode]);

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
          addToast({ message: "PIN must be reset. Unlock with the recovery key." });
        }
        setDefaultTab("import");
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

  const handleGenerateRecoveryKey = async (newKey: string) => {
    try {
      if (!validateRecoveryKey(newKey)) {
      addToast({ message: "???? ?? ?? ? ?????. (?: NKC-...)" });
        return;
      }

      await rotateVaultKeys(newKey, () => {});
      const vk = getVaultKey();
      if (vk) await setStoredSession(vk);

      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);

      addToast({ message: "복구키가 변경되었습니다. PIN을 다시 설정해 주세요." });
    } catch (error) {
      console.error("Failed to rotate recovery key", error);
      addToast({ message: "복구키 변경에 실패했습니다." });
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
    await saveProfile({ ...userProfile, avatarRef });
    await hydrateVault();
  };

  const handleSendMessage = async (text: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;

    const vk = getVaultKey();
    if (!vk) return;

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
      lastMessage: "채팅을 시작해요.",
      participants: [userProfile.id, friendId],
    };

    await saveConversation(newConv);

    await saveMessage({
      id: createId(),
      convId: newConv.id,
      senderId: userProfile.id,
      text: "채팅을 시작해요.",
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
      message: "삭제하면 복구할 수 없어요.",
      onConfirm: async () => {
        await updateConversation(convId, { hidden: true });
        addToast({
          message: "채팅이 삭제되었습니다.",
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
      title: "친구를 숨길까요?",
      message: "숨긴 친구는 친구 관리에서 다시 표시할 수 있어요.",
      onConfirm: async () => {
        await updateFriend(friendId, { friendStatus: "hidden" });
      },
    });
  };

  const handleFriendBlock = (friendId: string) => {
    setConfirm({
      title: "친구를 차단할까요?",
      message: "차단하면 채팅이 숨겨집니다.",
      onConfirm: async () => {
        try {
          await updateFriend(friendId, { friendStatus: "blocked" });
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true });
          }
        } catch (error) {
          console.error("Failed to block friend", error);
          addToast({ message: "친구 차단에 실패했습니다." });
        }
      },
    });
  };

  const handleFriendDelete = (friendId: string) => {
    setConfirm({
      title: "친구를 삭제할까요?",
      message: "삭제 후에는 다시 추가해야 해요.",
      onConfirm: async () => {
        try {
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true });
          }
          await deleteProfile(friendId);
          await hydrateVault();
        } catch (error) {
          console.error("Failed to delete friend", error);
          addToast({ message: "친구 삭제에 실패했습니다." });
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
      addToast({ message: "차단 해제에 실패했습니다." });
    }
  };

  const handleCopyShareId = async () => {
    try {
      if (!shareId) return;
      await navigator.clipboard.writeText(shareId);
      addToast({ message: "ID를 복사했습니다." });
    } catch (error) {
      console.error("Failed to copy share ID", error);
      addToast({ message: "ID 복사에 실패했습니다." });
    }
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

  const handleAddFriend = async (rawId: string) => {
    const trimmed = rawId.trim();

    if (!trimmed) {
      return { ok: false as const, error: "친구 ID를 입력해 주세요." };
    }
    if (!trimmed.startsWith("NCK-")) {
      return { ok: false as const, error: "유효한 친구 ID를 입력해 주세요." };
    }
    if (trimmed === shareId) {
      return { ok: false as const, error: "내 ID는 추가할 수 없습니다." };
    }
    if (friends.some((friend) => friend.friendId === trimmed)) {
      return { ok: false as const, error: "이미 추가된 친구입니다." };
    }

    try {
      const now = Date.now();
      const short = trimmed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);

      const friend: UserProfile = {
        id: createId(),
        friendId: trimmed,
        displayName: short ? `친구 ${short}` : "새 친구",
        status: "친구",
        theme: "dark",
        kind: "friend",
        friendStatus: "normal",
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
      return { ok: false as const, error: "친구 추가에 실패했습니다." };
    }
  };

  const currentConversation = ui.selectedConvId ? convs.find((conv) => conv.id === ui.selectedConvId) || null : null;
  const currentMessages = currentConversation ? messagesByConv[currentConversation.id] || [] : [];

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

  const partnerProfile = useMemo(() => {
    if (!currentConversation) return null;
    const partnerId = currentConversation.participants.find((id) => id !== userProfile?.id);
    return friends.find((friend) => friend.id === partnerId) || null;
  }, [currentConversation, friends, userProfile]);

  if (ui.mode === "onboarding") {
    return (
      <>
        <Onboarding
          onCreate={handleCreate}
          onImport={handleImport}
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
        messages={currentMessages}
        currentUserId={userProfile?.id || null}
        nameMap={nameMap}
        profilesById={profilesById}
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSend={handleSendMessage}
        onSendMedia={handleSendMedia}
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
          onOpenRecovery={() => navigate("/recovery")}
          hiddenFriends={friends.filter((friend) => friend.friendStatus === "hidden")}
          blockedFriends={friends.filter((friend) => friend.friendStatus === "blocked")}
          onUnhideFriend={handleFriendUnhide}
          onUnblockFriend={handleFriendUnblock}
          onLogout={() =>
            setConfirm({
              title: "로그아웃할까요?",
              message: "세션은 종료되고 로컬 데이터는 유지됩니다.",
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
          myId={shareId}
          onCopyId={handleCopyShareId}
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
          path="/recovery"
          element={
            ui.mode === "app" ? (
              <Recovery onGenerate={handleGenerateRecoveryKey} onDone={() => navigate("/settings")} />
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
          // confirm?.onConfirm() 이 Promise를 반환해도 UI는 void로 처리
          void confirm?.onConfirm?.();
        }}
        onClose={() => setConfirm(null)}
      />

      <Toasts />
    </>
  );
}
