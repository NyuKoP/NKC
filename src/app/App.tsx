import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock from "../components/Unlock";
import Recovery from "../components/Recovery";
import FriendAddDialog from "../components/FriendAddDialog";
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
  saveProfile,
  saveProfilePhoto,
  seedVaultData,
  unlockVault,
  wipeVault,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { validateRecoveryKey } from "../crypto/vault";
import { getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import { getShareId } from "../security/friendId";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { clearPin, clearPinRecord, getPinStatus, setPin as savePin, verifyPin } from "../security/pin";
import { clearRecoveryConfirmed } from "../security/recoveryKey";

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
  const [shareId, setShareId] = useState("");
  const onboardingLockRef = useRef(false);

  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const devLog = (message: string, detail?: Record<string, unknown>) => {
    if (!isDev) return;
    if (detail) {
      console.debug(`[app] ${message}`, detail);
    } else {
      console.debug(`[app] ${message}`);
    }
  };

  const settingsOpen = location.pathname === "/settings";

  const resetAppState = () => {
    setSessionState({ unlocked: false, vkInMemory: false });
    setData({ user: null, friends: [], convs: [], messagesByConv: {} });
    setSelectedConv(null);
  };

  useEffect(() => {
    if (!friendAddOpen || !userProfile) return;
    getShareId(userProfile.id)
      .then(setShareId)
      .catch((error) => console.error("Failed to derive share ID", error));
  }, [friendAddOpen, userProfile]);

  const withTimeout = async <T,>(promise: Promise<T>, label: string, ms = 15000) => {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  };

  const hydrateVault = async () => {
    try {
      devLog("hydrate:start");
      const vk = getVaultKey();
      if (vk) {
        const keyOk = await withTimeout(verifyVaultKeyId(vk), "verifyVaultKeyId");
        if (!keyOk) {
          throw new Error("Vault key mismatch");
        }
      }
      const profiles = await withTimeout(listProfiles(), "listProfiles");
      const user = profiles.find((profile) => profile.kind === "user") || null;
      const friendProfiles = profiles.filter((profile) => profile.kind === "friend");
      const conversations = await withTimeout(listConversations(), "listConversations");
      const messagesBy: Record<string, Message[]> = {};
      for (const conv of conversations) {
        messagesBy[conv.id] = await withTimeout(
          listMessagesByConv(conv.id),
          "listMessagesByConv"
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
      const message =
        error instanceof Error ? error.message : String(error);
      if (
        message.includes("ciphertext") ||
        message.includes("decrypted") ||
        message.includes("Vault key mismatch")
      ) {
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
          addToast({ message: "PIN을 다시 설정해야 합니다. 복구키로 잠금 해제하세요." });
        }
        setDefaultTab("import");
        setMode("onboarding");
      }
      addToast({ message: "세션이 만료되었습니다. 다시 확인해주세요." });
    }
  };

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
            addToast({ message: "PIN을 다시 설정해야 합니다. 복구키로 잠금 해제하세요." });
          }
          setDefaultTab("import");
          setMode("onboarding");
        }
      } catch (error) {
        console.error("Boot failed", error);
        addToast({ message: "저장소 초기화에 실패했습니다." });
        setMode("onboarding");
      }
    };

    boot();
    return () => {
      cancelled = true;
    };
  }, [addToast, setMode]);


  const handleCreate = async (displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;
    try {
      setOnboardingError("");
      console.log("Onboarding:create:start");
      await withTimeout(clearStoredSession(), "clearStoredSession");
      console.log("Onboarding:create:bootstrap:begin");
      await withTimeout(resetVaultStorage(), "resetVaultStorage");
      await withTimeout(bootstrapVault(), "bootstrapVault");
      console.log("Onboarding:create:bootstrap:end");
      const vk = getVaultKey();
      if (!vk) throw new Error("Vault key missing after bootstrap.");
      const now = Date.now();
      const user: UserProfile = {
        id: createId(),
        displayName,
        status: "NKC에서 온라인",
        theme: "dark",
        kind: "user",
        createdAt: now,
        updatedAt: now,
      };
      console.log("Onboarding:create:seed:begin");
      await withTimeout(seedVaultData(user), "seedVaultData");
      console.log("Onboarding:create:seed:end");
      await withTimeout(setStoredSession(vk), "setStoredSession");
      console.log("Onboarding:create:transition:begin");
      console.log("Onboarding:create:hydrate:begin");
      await withTimeout(hydrateVault(), "hydrateVault");
      console.log("Onboarding:create:hydrate:end");
      console.log("Onboarding:create:transition:end");
    } catch (error) {
      console.error("Vault bootstrap failed", error);
      setOnboardingError(
        error instanceof Error ? error.message : "금고 초기화에 실패했습니다."
      );
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
      addToast({
        message:
          "지원하는 복구키 형식: NKC-XXXX-XXXX-XXXX-XXXX 또는 64자리 HEX",
      });
      onboardingLockRef.current = false;
      return;
    }
    try {
      console.log("Onboarding:import:start");
      console.log("Onboarding:import:unlock:begin");
      await withTimeout(unlockVault(recoveryKey), "unlockVault");
      console.log("Onboarding:import:unlock:end");
      const vk = getVaultKey();
      if (!vk) throw new Error("Vault key missing after unlock.");
      console.log("Onboarding:import:seed:begin");
      const profiles = await withTimeout(listProfiles(), "listProfiles");
      if (!profiles.length) {
        const now = Date.now();
        const user: UserProfile = {
          id: createId(),
          displayName: displayName || "NKC 사용자",
          status: "NKC에서 온라인",
          theme: "dark",
          kind: "user",
          createdAt: now,
          updatedAt: now,
        };
        await withTimeout(seedVaultData(user), "seedVaultData");
      }
      console.log("Onboarding:import:seed:end");
      await withTimeout(setStoredSession(vk), "setStoredSession");
      console.log("Onboarding:import:transition:begin");
      console.log("Onboarding:import:hydrate:begin");
      await withTimeout(hydrateVault(), "hydrateVault");
      console.log("Onboarding:import:hydrate:end");
      console.log("Onboarding:import:transition:end");
    } catch (error) {
      console.error("Recovery import failed", error);
      lockVault();
      addToast({ message: "복구키가 일치하지 않습니다." });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handlePinUnlock = async (pin: string) => {
    const result = await verifyPin(pin);
    if (!result.ok) {
      if (result.reason === "not_set") {
        await clearPinRecord();
        setPinEnabled(true);
        setPinNeedsReset(true);
        setDefaultTab("import");
        setMode("onboarding");
        navigate("/");
        return {
          ok: false,
          error: "PIN을 다시 설정해야 합니다. 복구키로 잠금 해제하세요.",
        };
      }
      return {
        ok: false,
        error:
          result.reason === "locked"
            ? "잠시 후 다시 시도하세요."
            : "PIN이 올바르지 않습니다.",
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
      return { ok: false, error: "잠금 해제에 실패했습니다." };
    }
  };

  const handleLock = async () => {
    if (!pinEnabled || pinNeedsReset) {
      if (pinNeedsReset) {
        addToast({ message: "PIN을 다시 설정해야 잠금할 수 있습니다." });
        return;
      }
      addToast({ message: "PIN을 설정해야 잠금할 수 있습니다." });
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
      addToast({ message: "잠금 처리에 실패했습니다." });
    }
  };

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
  }, [pinEnabled, pinNeedsReset, ui.mode]);

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
          addToast({ message: "PIN을 다시 설정해야 합니다. 복구키로 잠금 해제하세요." });
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
      addToast({ message: "PIN이 설정되었습니다." });
      return { ok: true };
    } catch (error) {
      console.error("Failed to set PIN", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "PIN 설정에 실패했습니다.",
      };
    }
  };

  const handleDisablePin = async () => {
    try {
      await clearPin();
      setPinEnabled(false);
      setPinNeedsReset(false);
      addToast({ message: "PIN 잠금이 해제되었습니다." });
    } catch (error) {
      console.error("Failed to clear PIN", error);
      addToast({ message: "PIN 해제에 실패했습니다." });
    }
  };

  const handleGenerateRecoveryKey = async (newKey: string) => {
    try {
      if (!validateRecoveryKey(newKey)) {
        addToast({
          message:
            "지원하는 복구키 형식: NKC-XXXX-XXXX-XXXX-XXXX 또는 64자리 HEX",
        });
        return;
      }
      await rotateVaultKeys(newKey, () => {});
      const vk = getVaultKey();
      if (vk) {
        await setStoredSession(vk);
      }
      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);
      await clearRecoveryConfirmed();
      addToast({ message: "복구키가 변경되었습니다. PIN을 다시 설정해주세요." });
    } catch (error) {
      console.error("Failed to rotate recovery key", error);
      addToast({ message: "복구키 변경에 실패했습니다." });
      throw error;
    }
  };

  const handleSaveProfile = async (payload: {
    displayName: string;
    status: string;
    theme: "dark" | "light";
  }) => {
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
    const message: Message = {
      id: createId(),
      convId: conv.id,
      senderId: userProfile.id,
      text,
      ts: Date.now(),
    };
    await saveMessage(message);
    const updatedConv: Conversation = {
      ...conv,
      lastMessage: text,
      lastTs: message.ts,
      unread: 0,
    };
    await saveConversation(updatedConv);
    await hydrateVault();
  };

  const handleSelectConv = (convId: string) => {
    setSelectedConv(convId);
  };

  const handleSelectFriend = async (friendId: string) => {
    const existing = convs.find((conv) => conv.participants.includes(friendId));
    if (existing) {
      setSelectedConv(existing.id);
      setMode("app");
      return;
    }
    if (!userProfile) return;
    const friend = friends.find((item) => item.id === friendId);
    const newConv: Conversation = {
      id: createId(),
      name: friend?.displayName || "새 대화",
      pinned: friend?.isFavorite ?? false,
      unread: 0,
      hidden: false,
      muted: false,
      blocked: false,
      lastTs: Date.now(),
      lastMessage: "대화를 시작합니다.",
      participants: [userProfile.id, friendId],
    };
    await saveConversation(newConv);
    await saveMessage({
      id: createId(),
      convId: newConv.id,
      senderId: userProfile.id,
      text: "대화를 시작합니다.",
      ts: Date.now(),
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

  const handleHide = (convId: string) => {
    updateConversation(convId, { hidden: true });
    addToast({
      message: "대화를 숨겼어요.",
      actionLabel: "Undo",
      onAction: () => updateConversation(convId, { hidden: false }),
    });
  };

  const handleDelete = (convId: string) => {
    setConfirm({
      title: "대화를 삭제할까요?",
      message: "삭제하면 복구가 제한됩니다.",
      onConfirm: async () => {
        await updateConversation(convId, { hidden: true });
        addToast({
          message: "대화를 삭제했어요.",
          actionLabel: "Undo",
          onAction: () => updateConversation(convId, { hidden: false }),
        });
      },
    });
  };

  const handleTogglePin = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    if (!target) return;
    updateConversation(convId, { pinned: !target.pinned });
  };

  const handleMute = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    updateConversation(convId, { muted: !target?.muted });
  };

  const handleBlock = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    updateConversation(convId, { blocked: !target?.blocked });
  };

  const handleFriendChat = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
    } catch (error) {
      console.error("Failed to open chat", error);
      addToast({ message: "채팅 열기에 실패했습니다." });
    }
  };

  const handleFriendViewProfile = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
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
      const existing = convs.find((conv) => conv.participants.includes(friendId));
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
      message: "숨긴 친구는 친구 관리에서 다시 표시할 수 있습니다.",
      onConfirm: async () => {
        await updateFriend(friendId, { friendStatus: "hidden" });
      },
    });
  };

  const handleFriendBlock = (friendId: string) => {
    setConfirm({
      title: "친구를 차단할까요?",
      message: "차단하면 대화가 숨겨집니다.",
      onConfirm: async () => {
        try {
          await updateFriend(friendId, { friendStatus: "blocked" });
          const existing = convs.find((conv) => conv.participants.includes(friendId));
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
      message: "삭제 후에는 다시 추가해야 합니다.",
      onConfirm: async () => {
        try {
          const existing = convs.find((conv) => conv.participants.includes(friendId));
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
      const existing = convs.find((conv) => conv.participants.includes(friendId));
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
    addToast({ message: "그룹 만들기는 준비 중입니다." });
  };

  const handleAddFriend = async (rawId: string) => {
    const trimmed = rawId.trim();
    if (!trimmed) {
      return { ok: false, error: "친구 ID를 입력하세요." };
    }
    if (!trimmed.startsWith("NKC-")) {
      return { ok: false, error: "유효한 친구 ID를 입력하세요." };
    }
    if (trimmed === shareId) {
      return { ok: false, error: "내 ID는 추가할 수 없습니다." };
    }
    if (friends.some((friend) => friend.friendId === trimmed)) {
      return { ok: false, error: "이미 추가된 친구입니다." };
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
      console.log("Friend:add:success", friend.id);
      return { ok: true };
    } catch (error) {
      console.error("Friend:add failed", error);
      return { ok: false, error: "친구 추가에 실패했습니다." };
    }
  };

  const currentConversation = ui.selectedConvId
    ? convs.find((conv) => conv.id === ui.selectedConvId) || null
    : null;
  const currentMessages = currentConversation
    ? messagesByConv[currentConversation.id] || []
    : [];

  const nameMap = useMemo(
    () => buildNameMap([...(friends || []), ...(userProfile ? [userProfile] : [])]),
    [friends, userProfile]
  );

  const partnerProfile = useMemo(() => {
    if (!currentConversation) return null;
    const partnerId = currentConversation.participants.find(
      (id) => id !== userProfile?.id
    );
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
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSend={handleSendMessage}
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
              message: "세션만 삭제하고 로컬 데이터는 유지됩니다.",
              // TODO: Offer "keep data vs wipe" choice in the logout flow.
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
    </div>
  );

  return (
    <>
      <Routes>
        <Route
          path="/unlock"
          element={
            ui.mode === "locked" ? <Unlock onUnlock={handlePinUnlock} /> : <Navigate to="/" replace />
          }
        />
        <Route
          path="/recovery"
          element={
            ui.mode === "app" ? (
              <Recovery
                onGenerate={handleGenerateRecoveryKey}
                onDone={() => navigate("/settings")}
              />
            ) : (
              <Navigate to="/unlock" replace />
            )
          }
        />
        <Route
          path="/settings"
          element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />}
        />
        <Route
          path="/*"
          element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />}
        />
      </Routes>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        onConfirm={() => confirm?.onConfirm()}
        onClose={() => setConfirm(null)}
      />
      <Toasts />
    </>
  );
}
