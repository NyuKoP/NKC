import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronRight, Filter, Lock, Search, Settings, UserPlus, Users } from "lucide-react";
import type { AvatarRef, Conversation, UserProfile } from "../db/repo";
import { useAppStore } from "../app/store";
import OverflowMenu from "./OverflowMenu";
import FriendOverflowMenu from "./FriendOverflowMenu";
import Avatar from "./Avatar";
import { resolveFriendDisplayName } from "../utils/displayName";

const formatTime = (ts: number, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

type SidebarProps = {
  convs: Conversation[];
  friends: UserProfile[];
  userId: string | null;
  userProfile: UserProfile | null;
  groupAvatarRefsByConv: Record<string, AvatarRef | undefined>;
  friendAliasesById: Record<string, string | undefined>;
  selectedConvId: string | null;
  listMode: "chats" | "friends";
  listFilter: "all" | "unread" | "favorites";
  search: string;
  onSearch: (value: string) => void;
  onSelectConv: (id: string) => void;
  onAddFriend: () => void;
  onCreateGroup: () => void;
  onFriendChat: (id: string) => void;
  onFriendViewProfile: (id: string) => void;
  onFriendToggleFavorite: (id: string) => void;
  onFriendHide: (id: string) => void;
  onFriendDelete: (id: string) => void;
  onFriendBlock: (id: string) => void;
  onSetFriendAlias: (id: string, alias: string | null) => void | Promise<void>;
  onListModeChange: (mode: "chats" | "friends") => void;
  onListFilterChange: (value: "all" | "unread" | "favorites") => void;
  onSettings: () => void;
  onLock: () => void;
  onHide: (id: string) => void;
  onDelete: (id: string) => void;
  onMute: (id: string) => void;
  onBlock: (id: string) => void;
  onTogglePin: (id: string) => void;
};

export default function Sidebar({
  convs,
  friends,
  userId,
  userProfile,
  groupAvatarRefsByConv,
  friendAliasesById,
  selectedConvId,
  listMode,
  listFilter,
  search,
  onSearch,
  onSelectConv,
  onAddFriend,
  onCreateGroup,
  onFriendChat,
  onFriendViewProfile,
  onFriendToggleFavorite,
  onFriendHide,
  onFriendDelete,
  onFriendBlock,
  onSetFriendAlias,
  onListModeChange,
  onListFilterChange,
  onSettings,
  onLock,
  onHide,
  onDelete,
  onMute,
  onBlock,
  onTogglePin,
}: SidebarProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  const locale = language === "en" ? "en-US" : "ko-KR";
  const [now, setNow] = useState(() => Date.now());
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [friendsOpen, setFriendsOpen] = useState(true);
  const [pinnedChatsOpen, setPinnedChatsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [aliasDialogFriendId, setAliasDialogFriendId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const friendClickTimerRef = useRef<number | null>(null);
  const searchLower = search.trim().toLowerCase();
  const friendMap = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (friendClickTimerRef.current) {
        window.clearTimeout(friendClickTimerRef.current);
        friendClickTimerRef.current = null;
      }
    };
  }, []);

  const convLastByFriend = useMemo(() => {
    const map = new Map<string, number>();
    if (!userId) return map;
    for (const conv of convs) {
      if (conv.type === "group" || conv.participants.length > 2) continue;
      const friendId = conv.participants.find((id) => id !== userId);
      if (!friendId) continue;
      const prev = map.get(friendId) ?? 0;
      if (conv.lastTs > prev) {
        map.set(friendId, conv.lastTs);
      }
    }
    return map;
  }, [convs, userId]);

  const getFriendLastSeen = (friendId: string) => convLastByFriend.get(friendId) ?? 0;

  const getActivityLabel = (friend: UserProfile) => {
    const lastSeenAt = getFriendLastSeen(friend.id);
    if (!lastSeenAt) return t("기록 없음", "No activity");
    const ageMs = now - lastSeenAt;
    const minutes = Math.max(0, Math.floor(ageMs / (60 * 1000)));
    if (minutes === 0) return t("최근 대화 방금 전", "Last chat just now");
    return t(`최근 대화 ${minutes}분 전`, `Last chat ${minutes} min ago`);
  };

  const visibleConvs = convs
    .filter((conv) => !conv.hidden)
    .filter((conv) =>
      searchLower
        ? conv.name.toLowerCase().includes(searchLower) ||
          (conv.lastMessage || "").toLowerCase().includes(searchLower)
        : true
    )
    .sort((a, b) => b.lastTs - a.lastTs);

  const filteredConvs =
    listMode === "chats" && listFilter === "unread"
      ? visibleConvs.filter((conv) => conv.unread > 0)
      : visibleConvs;

  const pinned = filteredConvs.filter((conv) => conv.pinned);
  const regular = filteredConvs.filter((conv) => !conv.pinned);

  const getFriendDisplayName = (friend: UserProfile) =>
    resolveFriendDisplayName(friend, friendAliasesById);

  const visibleFriends = friends
    .filter((friend) => friend.friendStatus !== "hidden" && friend.friendStatus !== "blocked")
    .filter((friend) => {
      if (!searchLower) return true;
      return getFriendDisplayName(friend).toLowerCase().includes(searchLower);
    })
    .sort((a, b) => {
      if (a.isFavorite === b.isFavorite) {
        const aSeen = getFriendLastSeen(a.id);
        const bSeen = getFriendLastSeen(b.id);
        if (aSeen !== bSeen) {
          return bSeen - aSeen;
        }
        return getFriendDisplayName(a).localeCompare(getFriendDisplayName(b));
      }
      return a.isFavorite ? -1 : 1;
    });

  const filteredFriends =
    listMode === "friends" && listFilter === "favorites"
      ? visibleFriends.filter((friend) => friend.isFavorite)
      : visibleFriends;

  const favoriteFriends = filteredFriends.filter((friend) => friend.isFavorite);
  const regularFriends = filteredFriends.filter((friend) => !friend.isFavorite);

  const filterOptions: { value: SidebarProps["listFilter"]; label: string }[] =
    listMode === "chats"
      ? [
          { value: "all", label: t("전체", "All") },
          { value: "unread", label: t("읽지 않음", "Unread") },
        ]
      : [
          { value: "all", label: t("전체", "All") },
          { value: "favorites", label: t("즐겨찾기만 보기", "Favorites only") },
        ];

  const resolveConvFriend = (conv: Conversation) => {
    if (conv.type === "group" || conv.participants.length > 2) return undefined;
    const fid = conv.participants.find((id) => id !== userId);
    return fid ? friendMap.get(fid) : undefined;
  };

  const handleFriendClick = (friendId: string) => {
    if (friendClickTimerRef.current) {
      window.clearTimeout(friendClickTimerRef.current);
    }
    friendClickTimerRef.current = window.setTimeout(() => {
      onFriendViewProfile(friendId);
      friendClickTimerRef.current = null;
    }, 200);
  };

  const handleFriendDoubleClick = (friendId: string) => {
    if (friendClickTimerRef.current) {
      window.clearTimeout(friendClickTimerRef.current);
      friendClickTimerRef.current = null;
    }
    onFriendChat(friendId);
  };

  const openAliasDialog = (friend: UserProfile) => {
    setAliasDialogFriendId(friend.id);
    setAliasDraft(friendAliasesById[friend.id] ?? "");
  };

  const renderFriendRow = (friend: UserProfile) => {
    const displayName = getFriendDisplayName(friend);
    return (
      <div
        key={friend.id}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('[data-stop-row-click="true"]')) return;
          handleFriendClick(friend.id);
        }}
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('[data-stop-row-click="true"]')) return;
          handleFriendDoubleClick(friend.id);
        }}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement | null;
          if (target?.closest?.('[data-stop-row-click="true"]')) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFriendViewProfile(friend.id);
          }
        }}
        className="flex w-full items-start gap-3 rounded-nkc px-3 py-3 hover:bg-nkc-panelMuted"
      >
        <Avatar name={displayName} avatarRef={friend.avatarRef} size={42} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-nkc-text line-clamp-1">
            {displayName}
          </div>
          <div className="text-xs text-nkc-muted line-clamp-1">{getActivityLabel(friend)}</div>
        </div>
        <FriendOverflowMenu
          friendId={friend.id}
          isFavorite={friend.isFavorite}
          onChat={() => onFriendChat(friend.id)}
          onViewProfile={() => onFriendViewProfile(friend.id)}
          onToggleFavorite={() => onFriendToggleFavorite(friend.id)}
          onHide={() => onFriendHide(friend.id)}
          onDelete={() => onFriendDelete(friend.id)}
          onBlock={() => onFriendBlock(friend.id)}
          onRenameAlias={() => openAliasDialog(friend)}
        />
      </div>
    );
  };

  const aliasFriend = aliasDialogFriendId ? friendMap.get(aliasDialogFriendId) ?? null : null;
  const aliasOpen = Boolean(aliasDialogFriendId && aliasFriend);

  return (
    <aside className="flex h-full w-[320px] flex-col rounded-nkc border border-nkc-border bg-nkc-panel shadow-soft" data-testid="sidebar">
      <div className="border-b border-nkc-border p-6">
        <div className="flex items-center justify-between">
          <button
            onClick={onSettings}
            className="flex items-center gap-3 rounded-nkc px-2 py-1 hover:bg-nkc-panelMuted"
          >
            <Avatar
              name={userProfile?.displayName || "NKC"}
              avatarRef={userProfile?.avatarRef}
              size={36}
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-nkc-text line-clamp-1">
                {userProfile?.displayName || "NKC"}
              </div>
              <div className="text-xs text-nkc-muted line-clamp-1">
                {userProfile?.status || t("상태 없음", "No status")}
              </div>
            </div>
          </button>
          <div className="flex gap-2">
            <button
              onClick={onSettings}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border hover:bg-nkc-panelMuted"
              data-testid="open-settings"
            >
              <Settings size={16} />
            </button>
            <button
              onClick={onLock}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border hover:bg-nkc-panelMuted"
            >
              <Lock size={16} />
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panelMuted px-3 py-2">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t("검색", "Search")}
            className="w-full bg-transparent text-sm text-nkc-text placeholder:text-nkc-muted focus:outline-none"
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-xs">
          <button
            onClick={() => {
              onListModeChange("friends");
              onListFilterChange("all");
            }}
            className={`rounded-nkc px-3 py-2 font-semibold ${
              listMode === "friends" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            data-testid="list-mode-friends"
          >
            {t("친구", "Friends")}
          </button>
          <button
            onClick={() => {
              onListModeChange("chats");
              onListFilterChange("all");
            }}
            className={`rounded-nkc px-3 py-2 font-semibold ${
              listMode === "chats" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            data-testid="list-mode-chats"
          >
            {t("채팅", "Chats")}
          </button>
        </div>
      </div>

      <div className="border-b border-nkc-border px-6 py-4 space-y-3">
        <div className="flex items-center justify-between text-xs font-semibold text-nkc-muted">
          <span>{t("필터", "Filter")}</span>
          <div className="flex items-center gap-2">
            <Filter size={14} />
            <button
              onClick={onAddFriend}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-nkc-border hover:bg-nkc-panelMuted"
              aria-label={t("친구 추가", "Add friend")}
            >
              <UserPlus size={14} />
            </button>
            <button
              onClick={onCreateGroup}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-nkc-border hover:bg-nkc-panelMuted"
              aria-label={t("그룹 만들기", "Create group")}
            >
              <Users size={14} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-[11px]">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => onListFilterChange(option.value)}
              className={`rounded-nkc px-3 py-2 font-semibold ${
                listFilter === option.value ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 pt-0 space-y-6 scrollbar-hidden">
        {listMode === "chats" ? (
          <div className="space-y-0">
            {pinned.length > 0 && (
              <div className="border-t border-nkc-border -mx-4">
                <div className="px-6">
                  <button
                    onClick={() => setPinnedChatsOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-nkc-text"
                  >
                    <span>{t("고정된 채팅", "Pinned chats")} ({pinned.length})</span>
                    <span className="text-nkc-muted">
                      {pinnedChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                  </button>
                </div>
                {pinnedChatsOpen && (
                  <div className="divide-y border-t border-nkc-border">
                    {pinned.map((conv) => (
                      <div key={conv.id} className="px-6">
                        <ConversationRow
                          conv={conv}
                          friend={resolveConvFriend(conv)}
                          groupAvatarRefsByConv={groupAvatarRefsByConv}
                          friendAliasesById={friendAliasesById}
                          active={selectedConvId === conv.id}
                          locale={locale}
                          t={t}
                          onSelect={() => onSelectConv(conv.id)}
                          onHide={() => onHide(conv.id)}
                          onDelete={() => onDelete(conv.id)}
                          onMute={() => onMute(conv.id)}
                          onBlock={() => onBlock(conv.id)}
                          onTogglePin={() => onTogglePin(conv.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-nkc-border -mx-4">
              <div className="px-6">
                <button
                  onClick={() => setChatsOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-nkc-text"
                >
                  <span>{t("채팅", "Chats")} ({regular.length})</span>
                  <span className="text-nkc-muted">
                    {chatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
              </div>
              {chatsOpen && (
                regular.length > 0 ? (
                  <div className="divide-y border-t border-nkc-border">
                    {regular.map((conv) => (
                      <div key={conv.id} className="px-6">
                        <ConversationRow
                          conv={conv}
                          friend={resolveConvFriend(conv)}
                          groupAvatarRefsByConv={groupAvatarRefsByConv}
                          friendAliasesById={friendAliasesById}
                          active={selectedConvId === conv.id}
                          locale={locale}
                          t={t}
                          onSelect={() => onSelectConv(conv.id)}
                          onHide={() => onHide(conv.id)}
                          onDelete={() => onDelete(conv.id)}
                          onMute={() => onMute(conv.id)}
                          onBlock={() => onBlock(conv.id)}
                          onTogglePin={() => onTogglePin(conv.id)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-4">
                    <div className="rounded-nkc border border-dashed border-nkc-border px-4 py-4 text-xs text-nkc-muted">
                      {t("대화가 없습니다.", "No conversations.")}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-0">
            {favoriteFriends.length > 0 && (
              <div className="border-t border-nkc-border -mx-4">
                <div className="px-6">
                  <button
                    onClick={() => setFavoritesOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-nkc-text"
                  >
                    <span>{t("즐겨찾는 친구", "Favorite friends")} ({favoriteFriends.length})</span>
                    <span className="text-nkc-muted">
                      {favoritesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                  </button>
                </div>
                {favoritesOpen && (
                  <div className="divide-y border-t border-nkc-border">
                    {favoriteFriends.map((friend) => (
                      <div key={friend.id} className="px-6">
                        {renderFriendRow(friend)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="border-t border-nkc-border -mx-4">
              <div className="px-6">
                <button
                  onClick={() => setFriendsOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-nkc-text"
                >
                  <span>{t("친구", "Friends")} ({regularFriends.length})</span>
                  <span className="text-nkc-muted">
                    {friendsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
              </div>
              {friendsOpen && (
                regularFriends.length > 0 ? (
                  <div className="divide-y border-t border-nkc-border">
                    {regularFriends.map((friend) => (
                      <div key={friend.id} className="px-6">
                        {renderFriendRow(friend)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-4">
                    <div className="rounded-nkc border border-dashed border-nkc-border px-4 py-4 text-xs text-nkc-muted">
                      {t("표시할 친구가 없습니다.", "No friends to show.")}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
      <Dialog.Root
        open={aliasOpen}
        onOpenChange={(open) => {
          if (open) return;
          setAliasDialogFriendId(null);
          setAliasDraft("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-nkc border border-nkc-border bg-nkc-panel p-5 shadow-soft">
            <Dialog.Title className="text-sm font-semibold text-nkc-text">
              별명 바꾸기(나만)
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-nkc-muted">
              별명은 내 기기에서만 보입니다.
            </Dialog.Description>
            <input
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder={aliasFriend ? aliasFriend.displayName : ""}
              className="mt-3 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text outline-none focus:border-nkc-accent/60"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setAliasDialogFriendId(null);
                  setAliasDraft("");
                }}
                className="rounded-nkc border border-nkc-border px-3 py-1.5 text-xs text-nkc-text hover:bg-nkc-panelMuted"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!aliasFriend) return;
                  const next = aliasDraft.trim();
                  void onSetFriendAlias(aliasFriend.id, next || null);
                  setAliasDialogFriendId(null);
                  setAliasDraft("");
                }}
                className="rounded-nkc bg-nkc-accent px-3 py-1.5 text-xs font-semibold text-nkc-bg"
              >
                저장
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
}

type ConversationRowProps = {
  conv: Conversation;
  friend?: UserProfile;
  groupAvatarRefsByConv: Record<string, AvatarRef | undefined>;
  friendAliasesById: Record<string, string | undefined>;
  active: boolean;
  locale: string;
  t: (ko: string, en: string) => string;
  onSelect: () => void;
  onHide: () => void;
  onDelete: () => void;
  onMute: () => void;
  onBlock: () => void;
  onTogglePin: () => void;
};

function ConversationRow({
  conv,
  friend,
  groupAvatarRefsByConv,
  friendAliasesById,
  active,
  locale,
  t,
  onSelect,
  onHide,
  onDelete,
  onMute,
  onBlock,
  onTogglePin,
}: ConversationRowProps) {
  const handleSelect = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[data-stop-row-click="true"]')) return;
    onSelect();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('[data-stop-row-click="true"]')) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex gap-3 rounded-nkc border px-3 py-3 ${
        active
          ? "border-nkc-accent/40 bg-nkc-panelMuted"
          : "border-transparent hover:bg-nkc-panelMuted"
      }`}
      data-testid={`conversation-row-${conv.id}`}
      data-conversation-id={conv.id}
      data-selected={active ? "true" : "false"}
    >
      {(() => {
        const isGroup = conv.type === "group" || conv.participants.length > 2;
        const avatarRef = isGroup ? groupAvatarRefsByConv[conv.id] : friend?.avatarRef;
        const directName = resolveFriendDisplayName(friend, friendAliasesById);
        const avatarName = isGroup ? conv.name : directName;
        return <Avatar name={avatarName} avatarRef={avatarRef} size={40} />;
      })()}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-nkc-text">
            {conv.type === "group" || conv.participants.length > 2
              ? conv.name
              : resolveFriendDisplayName(friend, friendAliasesById)}
          </span>
          <span className="shrink-0 text-xs text-nkc-muted">
            {formatTime(conv.lastTs, locale)}
          </span>
        </div>
        <div className="mt-1 text-xs text-nkc-muted line-clamp-2">{conv.lastMessage}</div>
        <div className="mt-2 flex gap-2 text-[11px] text-nkc-muted">
          {conv.blocked && <span>{t("차단됨", "Blocked")}</span>}
        </div>
      </div>
      <div className="shrink-0">
        <OverflowMenu
          conversationId={conv.id}
          onHide={onHide}
          onDelete={onDelete}
          onMute={onMute}
          onBlock={onBlock}
          onTogglePin={onTogglePin}
          muted={conv.muted}
          pinned={conv.pinned}
        />
      </div>
    </div>
  );
}








