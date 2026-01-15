import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock from "../components/Unlock";
import Sidebar from "../components/Sidebar";
import ChatView from "../components/ChatView";
import RightPanel from "../components/RightPanel";
import SettingsDialog from "../components/SettingsDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import Toasts from "../components/Toasts";
import { createId } from "../utils/ids";
import {
  getVaultHeader,
  listConversations,
  listMessagesByConv,
  listProfiles,
  lockVault,
  rotateVaultKeys,
  wipeVault,
  saveConversation,
  saveMessage,
  saveProfile,
  saveProfilePhoto,
  seedVaultData,
  unlockVault,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { validateRecoveryKey } from "../crypto/vault";

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
  const setSession = useAppStore((state) => state.setSession);
  const setData = useAppStore((state) => state.setData);
  const addToast = useAppStore((state) => state.addToast);
  const confirm = useAppStore((state) => state.ui.confirm);
  const setConfirm = useAppStore((state) => state.setConfirm);

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const boot = async () => {
      try {
        const header = await getVaultHeader();
        if (!header) {
          setMode("onboarding");
        } else {
          setMode("locked");
        }
      } catch (error) {
        addToast({ message: "저장소 초기화에 실패했습니다." });
        setMode("onboarding");
      }
    };

    boot();
  }, [addToast, setMode]);

  const hydrateVault = async () => {
    const profiles = await listProfiles();
    const user = profiles.find((profile) => profile.kind === "user") || null;
    const friendProfiles = profiles.filter((profile) => profile.kind === "friend");
    const conversations = await listConversations();
    const messagesBy: Record<string, Message[]> = {};
    for (const conv of conversations) {
      messagesBy[conv.id] = await listMessagesByConv(conv.id);
    }
    setData({ user, friends: friendProfiles, convs: conversations, messagesByConv: messagesBy });
    setSession({ unlocked: true, vkInMemory: true });
    setMode("app");
  };

  const handleCreate = async (recoveryKey: string, displayName: string) => {
    if (!validateRecoveryKey(recoveryKey)) {
      addToast({ message: "복구키 형식이 올바르지 않습니다." });
      return;
    }
    try {
      await unlockVault(recoveryKey);
      const user: UserProfile = {
        id: createId(),
        displayName,
        status: "NKC에서 온라인",
        theme: "dark",
        kind: "user",
      };
      await seedVaultData(user);
      await hydrateVault();
    } catch (error) {
      lockVault();
      addToast({ message: "금고 초기화에 실패했습니다." });
    }
  };

  const handleImport = async (recoveryKey: string, displayName: string) => {
    if (!validateRecoveryKey(recoveryKey)) {
      addToast({ message: "복구키 형식이 올바르지 않습니다." });
      return;
    }
    try {
      await unlockVault(recoveryKey);
      const profiles = await listProfiles();
      if (!profiles.length) {
        const user: UserProfile = {
          id: createId(),
          displayName: displayName || "NKC 사용자",
          status: "NKC에서 온라인",
          theme: "dark",
          kind: "user",
        };
        await seedVaultData(user);
      }
      await hydrateVault();
    } catch (error) {
      lockVault();
      addToast({ message: "복구키가 일치하지 않습니다." });
    }
  };

  const handleUnlock = async (recoveryKey: string) => {
    if (!validateRecoveryKey(recoveryKey)) {
      addToast({ message: "복구키 형식이 올바르지 않습니다." });
      return;
    }
    try {
      await unlockVault(recoveryKey);
      await hydrateVault();
    } catch (error) {
      lockVault();
      addToast({ message: "복구키가 일치하지 않습니다." });
    }
  };

  const handleLock = () => {
    lockVault();
    setSession({ unlocked: false, vkInMemory: false });
    setData({ user: null, friends: [], convs: [], messagesByConv: {} });
    setSelectedConv(null);
    setMode("locked");
  };

  const handleSaveProfile = async (payload: {
    displayName: string;
    status: string;
    theme: "dark" | "light";
  }) => {
    if (!userProfile) return;
    const updated: UserProfile = { ...userProfile, ...payload };
    await saveProfile(updated);
    await hydrateVault();
  };

  const handleUploadPhoto = async (file: File) => {
    if (!userProfile) return;
    const avatarRef = await saveProfilePhoto(userProfile.id, file);
    await saveProfile({ ...userProfile, avatarRef });
    await hydrateVault();
  };

  const handleRotateKeys = async (newKey: string, onProgress: (value: number) => void) => {
    if (!validateRecoveryKey(newKey)) {
      addToast({ message: "복구키 형식이 올바르지 않습니다." });
      return;
    }
    await rotateVaultKeys(newKey, onProgress);
    addToast({ message: "복구키가 변경되었습니다." });
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
      pinned: false,
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

  const handleMute = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    updateConversation(convId, { muted: !target?.muted });
  };

  const handleBlock = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    updateConversation(convId, { blocked: !target?.blocked });
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
        <Onboarding onCreate={handleCreate} onImport={handleImport} />
        <Toasts />
      </>
    );
  }

  if (ui.mode === "locked") {
    return (
      <>
        <Unlock onUnlock={handleUnlock} />
        <Toasts />
      </>
    );
  }

  return (
    <div className="flex h-full gap-6 bg-nkc-bg p-6">
      <Sidebar
        convs={convs}
        friends={friends}
        userId={userProfile?.id || null}
        selectedConvId={ui.selectedConvId}
        listMode={ui.listMode}
        search={ui.search}
        onSearch={setSearch}
        onSelectConv={handleSelectConv}
        onSelectFriend={handleSelectFriend}
        onListModeChange={setListMode}
        onSettings={() => setSettingsOpen(true)}
        onLock={handleLock}
        onHide={handleHide}
        onDelete={handleDelete}
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
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {userProfile ? (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          user={userProfile}
          onSaveProfile={handleSaveProfile}
          onUploadPhoto={handleUploadPhoto}
          onLock={handleLock}
          onRotateKey={handleRotateKeys}
          onLogout={() => setConfirm({
            title: "로그아웃할까요?",
            message: "복구키 없이는 다시 접근할 수 없습니다.",
            onConfirm: handleLock,
          })}
          onWipe={() =>
            setConfirm({
              title: "데이터를 삭제할까요?",
              message: "로컬 금고가 초기화됩니다.",
              onConfirm: async () => {
                await wipeVault();
                window.location.reload();
              },
            })
          }
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        onConfirm={() => confirm?.onConfirm()}
        onClose={() => setConfirm(null)}
      />
      <Toasts />
    </div>
  );
}
