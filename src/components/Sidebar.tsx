import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AvatarRef, Conversation, UserProfile } from "../db/repo";
import { useAppStore } from "../app/store";
import OverflowMenu from "./OverflowMenu";
import FriendOverflowMenu from "./FriendOverflowMenu";
import Avatar from "./Avatar";
import { resolveFriendDisplayName } from "../utils/displayName";
import {
  AddFriendIcon,
  GroupIcon,
  MessageIcon,
  MoonIcon,
  PanelIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
} from "./icons/Icons";

const formatTime = (ts: number, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

type SidebarProps = {
  convs: Conversation[];
  friends: UserProfile[];
  userId: string | null;
  groupAvatarRefsByConv: Record<string, AvatarRef | undefined>;
  friendAliasesById: Record<string, string | undefined>;
  selectedConvId: string | null;
  networkStatus?: {
    state: "connected" | "connecting" | "disconnected" | "error";
    label: string;
  };
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
  theme: "dark" | "light";
  onToggleTheme: () => void | Promise<void>;
  onSettings: () => void;
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
  groupAvatarRefsByConv,
  friendAliasesById,
  selectedConvId,
  networkStatus,
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
  theme,
  onToggleTheme,
  onSettings,
  onHide,
  onDelete,
  onMute,
  onBlock,
  onTogglePin,
}: SidebarProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  const locale = language === "en" ? "en-US" : "ko-KR";
  const resolvedNetworkStatus = networkStatus ?? {
    state: "disconnected" as const,
    label: t("연결 안됨", "Disconnected"),
  };
  const networkStatusDotClass =
    resolvedNetworkStatus.state === "connected"
      ? "bg-emerald-500"
      : resolvedNetworkStatus.state === "connecting"
        ? "bg-amber-500"
        : resolvedNetworkStatus.state === "error"
          ? "bg-red-500"
          : "bg-nkc-muted";
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [friendsOpen, setFriendsOpen] = useState(true);
  const [pinnedChatsOpen, setPinnedChatsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [tabsVisible, setTabsVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("nkc.sidebar.tabsVisible") !== "false";
  });
  const [aliasDialogFriendId, setAliasDialogFriendId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const friendClickTimerRef = useRef<number | null>(null);
  const searchLower = search.trim().toLowerCase();
  const friendMap = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends]);

  const updateTabsVisibility = (visible: boolean) => {
    setTabsVisible(visible);
    window.localStorage.setItem("nkc.sidebar.tabsVisible", String(visible));
  };

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

  const filteredFriends = friends
    .map((friend) => ({
      friend,
      displayName: resolveFriendDisplayName(friend, friendAliasesById),
    }))
    .filter(({ friend, displayName }) => {
      if (friend.friendStatus === "hidden" || friend.friendStatus === "blocked") return false;
      if (!searchLower) return true;
      return displayName.toLowerCase().includes(searchLower);
    })
    .sort((a, b) => {
      if (a.friend.isFavorite === b.friend.isFavorite) {
        const aSeen = getFriendLastSeen(a.friend.id);
        const bSeen = getFriendLastSeen(b.friend.id);
        if (aSeen !== bSeen) {
          return bSeen - aSeen;
        }
        return a.displayName.localeCompare(b.displayName);
      }
      return a.friend.isFavorite ? -1 : 1;
    });

  const favoriteFriends = filteredFriends.filter(({ friend }) => friend.isFavorite);
  const regularFriends = filteredFriends.filter(({ friend }) => !friend.isFavorite);
  const unreadConversationCount = visibleConvs.reduce((total, conv) => total + conv.unread, 0);
  const incomingFriendRequestCount = friends.filter(
    (friend) => friend.friendStatus === "request_in"
  ).length;

  const filterOptions: { value: SidebarProps["listFilter"]; label: string }[] =
    listMode === "chats"
      ? [
          { value: "all", label: t("전체", "All") },
          { value: "unread", label: t("읽지 않음", "Unread") },
        ]
      : [{ value: "all", label: t("전체", "All") }];

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

  const getFriendStatusBadge = (friend: UserProfile) => {
    if (friend.friendStatus === "blocked") return t("차단됨", "Blocked");
    if (friend.friendStatus === "request_in") return t("요청 받음", "Request received");
    if (friend.friendStatus === "request_out") return t("요청 보냄", "Request sent");
    return null;
  };

  const renderFriendRow = (friend: UserProfile, displayName: string) => {
    const statusBadge = getFriendStatusBadge(friend);
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
        onMouseDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (!target?.closest?.('[data-stop-row-click="true"]')) event.preventDefault();
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
        className="group flex min-h-[72px] w-full cursor-pointer items-center gap-3 rounded-[10px] px-5 py-2 text-nkc-text transition-colors duration-100 hover:bg-nkc-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nkc-listFocus"
      >
        <div className="shrink-0">
          <Avatar name={displayName} avatarRef={friend.avatarRef} size={40} />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold tracking-normal text-nkc-text">
            {displayName}
            </span>
            {statusBadge ? (
              <span className="shrink-0 rounded border border-nkc-border bg-nkc-panel px-1.5 py-0.5 text-[10px] font-medium text-nkc-muted">
                {statusBadge}
              </span>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
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
      </div>
    );
  };

  const aliasFriend = aliasDialogFriendId ? friendMap.get(aliasDialogFriendId) ?? null : null;
  const aliasOpen = Boolean(aliasDialogFriendId && aliasFriend);

  return (
    <aside
      className={`flex h-full shrink-0 border-r border-nkc-border bg-nkc-panel transition-[width] duration-150 ${
        tabsVisible ? "w-[360px]" : "w-[296px]"
      }`}
      data-testid="sidebar"
    >
      {tabsVisible ? (
      <nav
        className="flex w-16 shrink-0 flex-col items-center border-r border-nkc-border bg-nkc-panelMuted py-3"
        data-testid="sidebar-tabs"
      >
        <button
          type="button"
          onClick={() => updateTabsVisibility(false)}
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
          data-testid="sidebar-tabs-toggle"
          aria-label={t("탭 숨기기", "Hide tabs")}
          title={t("탭 숨기기", "Hide tabs")}
        >
          <PanelIcon className="h-5 w-5" />
        </button>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              onListModeChange("chats");
              onListFilterChange("all");
            }}
            className={`relative flex h-11 w-11 items-center justify-center rounded-xl ${
              listMode === "chats" ? "bg-nkc-selected text-nkc-accent" : "text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            }`}
            data-testid="list-mode-chats"
            aria-label={t("채팅", "Chats")}
          >
            <MessageIcon className="h-5 w-5" />
            {unreadConversationCount > 0 ? (
              <span
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-nkc-accent px-1 text-[9px] font-bold leading-none text-white"
                aria-label={t(`읽지 않은 대화 ${unreadConversationCount}개`, `${unreadConversationCount} unread chats`)}
              >
                {unreadConversationCount > 99 ? "99+" : unreadConversationCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => {
              onListModeChange("friends");
              onListFilterChange("all");
            }}
            className={`relative flex h-11 w-11 items-center justify-center rounded-xl ${
              listMode === "friends" ? "bg-nkc-selected text-nkc-accent" : "text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            }`}
            data-testid="list-mode-friends"
            aria-label={t("친구", "Friends")}
          >
            <UsersIcon className="h-5 w-5" />
            {incomingFriendRequestCount > 0 ? (
              <span
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-nkc-accent px-1 text-[9px] font-bold leading-none text-white"
                aria-label={t(`새 친구 요청 ${incomingFriendRequestCount}개`, `${incomingFriendRequestCount} new friend requests`)}
              >
                {incomingFriendRequestCount > 99 ? "99+" : incomingFriendRequestCount}
              </span>
            ) : null}
          </button>
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void onToggleTheme()}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            data-testid="theme-quick-toggle"
            aria-label={
              theme === "light"
                ? t("다크 모드로 전환", "Switch to dark mode")
                : t("라이트 모드로 전환", "Switch to light mode")
            }
            title={theme === "light" ? t("라이트 모드", "Light mode") : t("다크 모드", "Dark mode")}
          >
            {theme === "light" ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onSettings}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            data-testid="open-settings"
            aria-label={t("설정", "Settings")}
            title={t("설정", "Settings")}
          >
            <SettingsIcon className="h-5 w-5" />
          </button>
        </div>
      </nav>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[64px] items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-2">
            {!tabsVisible ? (
              <button
                type="button"
                onClick={() => updateTabsVisibility(true)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
                data-testid="sidebar-tabs-toggle"
                aria-label={t("탭 표시", "Show tabs")}
                title={t("탭 표시", "Show tabs")}
              >
                <PanelIcon className="h-5 w-5" />
              </button>
            ) : null}
            <h1 className="truncate text-xl font-semibold tracking-[-0.02em] text-nkc-text">
              {listMode === "chats" ? t("대화", "Chats") : t("친구", "Friends")}
            </h1>
          </div>
          <div className="flex items-center gap-1">
            {listMode === "friends" ? (
              <button
                onClick={onAddFriend}
                className="flex h-9 w-9 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
                aria-label={t("친구 추가", "Add friend")}
                title={t("친구 추가", "Add friend")}
              >
                <AddFriendIcon className="h-[18px] w-[18px]" />
              </button>
            ) : (
              <button
                onClick={onCreateGroup}
                className="flex h-9 w-9 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
                aria-label={t("그룹 만들기", "Create group")}
                title={t("그룹 만들기", "Create group")}
              >
                <GroupIcon className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        </header>

        <div className="px-3 pb-3" data-testid="sidebar-search-region">
        <div className="flex items-center gap-2 rounded-lg bg-nkc-hover px-3 py-2">
          <SearchIcon className="h-4 w-4 shrink-0" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={
              listMode === "chats" ? t("대화 검색", "Search chats") : t("친구 검색", "Search friends")
            }
            className="w-full bg-transparent text-sm text-nkc-text placeholder:text-nkc-muted focus:outline-none"
          />
        </div>
        </div>

      {listMode === "chats" ? (
        <div
          className="space-y-2 px-4 py-2"
          data-testid="conversation-filters"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-nkc-muted">
            <div className="flex items-center gap-2 rounded-lg bg-nkc-hover p-1 text-[11px]">
              {filterOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => onListFilterChange(option.value)}
                  className={`rounded-md px-3 py-1.5 font-semibold ${
                    listFilter === option.value ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div />
          </div>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-1 space-y-4 scrollbar-hidden">
        {listMode === "chats" ? (
          <div className="space-y-0">
            {pinned.length > 0 && (
              <div className="-mx-4 pt-1">
                <div className="px-6">
                  <button
                    onClick={() => setPinnedChatsOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between px-2 py-1.5 text-[13px] font-bold tracking-normal text-nkc-muted"
                  >
                    <span>{t("고정된 채팅", "Pinned chats")} ({pinned.length})</span>
                    <span className="text-nkc-muted">
                      {pinnedChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                  </button>
                </div>
                {pinnedChatsOpen && (
                  <div className="space-y-1">
                    {pinned.map((conv) => (
                      <div key={conv.id} className="px-[18px]">
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

            <div
              className={`${pinned.length > 0 ? "mt-3 pt-1" : "pt-1"} -mx-4`}
            >
              <div className="px-6">
                <button
                  onClick={() => setChatsOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between px-2 py-1.5 text-[13px] font-bold tracking-normal text-nkc-muted"
                >
                  <span>{t("채팅", "Chats")} ({regular.length})</span>
                  <span className="text-nkc-muted">
                    {chatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
              </div>
              {chatsOpen && (
                regular.length > 0 ? (
                  <div className="space-y-1">
                    {regular.map((conv) => (
                      <div key={conv.id} className="px-[18px]">
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
                  <div className="flex min-h-[360px] items-center justify-center px-6 py-4">
                    <div className="px-4 py-6 text-center text-nkc-muted">
                      <div className="text-base font-semibold text-nkc-text">
                        {t("대화 없음", "No conversations")}
                      </div>
                      <div className="mt-3 text-xs leading-5">
                        {t("최근 대화가 여기에 표시됩니다.", "Recent conversations will appear here.")}
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-0">
            {favoriteFriends.length > 0 && (
              <div className="-mx-4">
                <div className="px-6">
                  <button
                    onClick={() => setFavoritesOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between px-2 py-1.5 text-[13px] font-bold tracking-normal text-nkc-muted"
                  >
                    <span>{t("즐겨찾는 친구", "Favorite friends")} ({favoriteFriends.length})</span>
                    <span className="text-nkc-muted">
                      {favoritesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                  </button>
                </div>
                {favoritesOpen && (
                  <div className="space-y-1">
                    {favoriteFriends.map(({ friend, displayName }) => (
                      <div key={friend.id} className="px-[18px]">
                        {renderFriendRow(friend, displayName)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div
              className={`-mx-4 ${favoriteFriends.length > 0 ? "mt-3" : ""}`}
              data-testid="friends-section"
            >
              <div className="px-6">
                <button
                  onClick={() => setFriendsOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between px-2 py-1.5 text-[13px] font-bold tracking-normal text-nkc-muted"
                >
                  <span>{t("친구", "Friends")} ({regularFriends.length})</span>
                  <span className="text-nkc-muted">
                    {friendsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
              </div>
              {friendsOpen && (
                regularFriends.length > 0 ? (
                  <div className="space-y-1">
                    {regularFriends.map(({ friend, displayName }) => (
                      <div key={friend.id} className="px-[18px]">
                        {renderFriendRow(friend, displayName)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-8 text-center">
                    <div className="text-sm font-semibold text-nkc-text">
                      {t("친구 없음", "No friends")}
                    </div>
                    <div className="mt-2 text-xs leading-5 text-nkc-muted">
                      {t("친구를 추가하면 여기에 표시됩니다.", "Friends you add will appear here.")}
                    </div>
                    <button
                      type="button"
                      onClick={onAddFriend}
                      className="mt-4 rounded-full bg-nkc-accent px-4 py-2 text-xs font-semibold text-white hover:brightness-110"
                    >
                      {t("친구 추가", "Add friend")}
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-nkc-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-nkc-muted">
          <span className={`h-2 w-2 shrink-0 rounded-full ${networkStatusDotClass}`} />
          <span className="truncate">{resolvedNetworkStatus.label}</span>
        </div>
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
          <Dialog.Overlay className="fixed inset-0 bg-black/70" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-nkc-border bg-nkc-surface p-5 animate-signal-fade-scale">
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
              className="mt-3 w-full rounded-lg border border-nkc-border bg-nkc-hover px-3 py-2 text-sm text-nkc-text outline-none focus:border-nkc-accent"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setAliasDialogFriendId(null);
                  setAliasDraft("");
                }}
                className="rounded-lg px-3 py-1.5 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
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
                className="rounded-lg bg-nkc-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
              >
                저장
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      </div>
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
      aria-pressed={active}
      tabIndex={0}
      onClick={handleSelect}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest?.('[data-stop-row-click="true"]')) event.preventDefault();
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('[data-stop-row-click="true"]')) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group relative flex min-h-[72px] gap-3 rounded-[10px] px-5 py-2 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nkc-listFocus ${
        active
          ? "bg-nkc-listSelected"
          : "hover:bg-nkc-hover"
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
        return <Avatar name={avatarName} avatarRef={avatarRef} size={44} />;
      })()}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-nkc-text">
            {conv.type === "group" || conv.participants.length > 2
              ? conv.name
              : resolveFriendDisplayName(friend, friendAliasesById)}
          </span>
          <span className="shrink-0 text-[11px] text-nkc-muted">
            {formatTime(conv.lastTs, locale)}
          </span>
          {conv.unread > 0 ? (
            <span className="shrink-0 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-nkc-accent px-1 text-[10px] font-bold text-white">
              {conv.unread > 99 ? '99+' : conv.unread}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-nkc-muted line-clamp-1">{conv.lastMessage}</div>
        <div className="mt-1 flex gap-2 text-[11px] text-nkc-muted">
          {conv.blocked && <span>{t("차단됨", "Blocked")}</span>}
        </div>
      </div>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
