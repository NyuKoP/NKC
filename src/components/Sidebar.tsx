import { Filter, Lock, Search, Settings } from "lucide-react";
import type { Conversation, UserProfile } from "../db/repo";
import OverflowMenu from "./OverflowMenu";
import FriendOverflowMenu from "./FriendOverflowMenu";
import Avatar from "./Avatar";

const formatTime = (ts: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

type SidebarProps = {
  convs: Conversation[];
  friends: UserProfile[];
  userId: string | null;
  userProfile: UserProfile | null;
  selectedConvId: string | null;
  listMode: "chats" | "friends";
  search: string;
  onSearch: (value: string) => void;
  onSelectConv: (id: string) => void;
  onAddFriend: () => void;
  onFriendChat: (id: string) => void;
  onFriendViewProfile: (id: string) => void;
  onFriendToggleFavorite: (id: string) => void;
  onFriendHide: (id: string) => void;
  onFriendDelete: (id: string) => void;
  onFriendBlock: (id: string) => void;
  onListModeChange: (mode: "chats" | "friends") => void;
  onSettings: () => void;
  onLock: () => void;
  onHide: (id: string) => void;
  onDelete: (id: string) => void;
  onMute: (id: string) => void;
  onBlock: (id: string) => void;
};

export default function Sidebar({
  convs,
  friends,
  userId,
  userProfile,
  selectedConvId,
  listMode,
  search,
  onSearch,
  onSelectConv,
  onAddFriend,
  onFriendChat,
  onFriendViewProfile,
  onFriendToggleFavorite,
  onFriendHide,
  onFriendDelete,
  onFriendBlock,
  onListModeChange,
  onSettings,
  onLock,
  onHide,
  onDelete,
  onMute,
  onBlock,
}: SidebarProps) {
  const searchLower = search.trim().toLowerCase();
  const friendMap = new Map(friends.map((friend) => [friend.id, friend]));
  const visibleConvs = convs
    .filter((conv) => !conv.hidden)
    .filter((conv) =>
      searchLower
        ? conv.name.toLowerCase().includes(searchLower) ||
          (conv.lastMessage || "").toLowerCase().includes(searchLower)
        : true
    )
    .sort((a, b) => b.lastTs - a.lastTs);

  const pinned = visibleConvs.filter((conv) => conv.pinned);
  const regular = visibleConvs.filter((conv) => !conv.pinned);
  const visibleFriends = friends
    .filter((friend) => friend.friendStatus !== "hidden" && friend.friendStatus !== "blocked")
    .filter((friend) =>
      searchLower ? friend.displayName.toLowerCase().includes(searchLower) : true
    )
    .sort((a, b) => {
      if (a.isFavorite === b.isFavorite) {
        return a.displayName.localeCompare(b.displayName);
      }
      return a.isFavorite ? -1 : 1;
    });

  return (
    <aside className="flex h-full w-[320px] flex-col rounded-nkc border border-nkc-border bg-nkc-panel shadow-soft">
      <div className="border-b border-nkc-border p-6">
        <div className="flex items-center justify-between">
          <button
            onClick={onSettings}
            className="flex items-center gap-3 rounded-nkc border border-transparent px-2 py-1 text-left hover:bg-nkc-panelMuted"
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
                {userProfile?.status || "로컬 상태"}
              </div>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onSettings}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text"
            >
              <Settings size={16} />
            </button>
            <button
              onClick={onLock}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text"
            >
              <Lock size={16} />
            </button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panelMuted px-3 py-2 text-sm text-nkc-muted">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="검색"
            className="w-full bg-transparent text-sm text-nkc-text placeholder:text-nkc-muted focus:outline-none"
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-xs">
          <button
            className={`rounded-nkc px-3 py-2 font-semibold ${
              listMode === "chats" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            onClick={() => onListModeChange("chats")}
          >
            대화
          </button>
          <button
            className={`rounded-nkc px-3 py-2 font-semibold ${
              listMode === "friends" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            onClick={() => onListModeChange("friends")}
          >
            친구
          </button>
        </div>
      </div>

      <div className="scrollbar-thin flex-1 space-y-6 overflow-y-auto p-6">
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-nkc-muted">
          <span>메뉴</span>
          <Filter size={14} />
        </div>
        <div className="grid gap-2 text-xs text-nkc-muted">
          <button
            onClick={onAddFriend}
            className="rounded-nkc border border-nkc-border px-3 py-2 text-left hover:bg-nkc-panelMuted"
          >
            친구 추가
          </button>
          <button className="rounded-nkc border border-nkc-border px-3 py-2 text-left hover:bg-nkc-panelMuted">
            그룹 만들기
          </button>
        </div>

        {listMode === "chats" ? (
          <div className="space-y-5">
            {pinned.length ? (
              <section className="space-y-3">
                <h2 className="text-xs uppercase tracking-widest text-nkc-muted">Pinned</h2>
                <div className="space-y-2">
                  {pinned.map((conv) => (
                    <ConversationRow
                      key={conv.id}
                      conv={conv}
                      friend={friendMap.get(
                        conv.participants.find((id) => id !== userId) || ""
                      )}
                      active={selectedConvId === conv.id}
                      onSelect={() => onSelectConv(conv.id)}
                      onHide={() => onHide(conv.id)}
                      onDelete={() => onDelete(conv.id)}
                      onMute={() => onMute(conv.id)}
                      onBlock={() => onBlock(conv.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <section className="space-y-3">
              <h2 className="text-xs uppercase tracking-widest text-nkc-muted">All</h2>
              <div className="space-y-2">
                {regular.length ? (
                  regular.map((conv) => (
                    <ConversationRow
                      key={conv.id}
                      conv={conv}
                      friend={friendMap.get(
                        conv.participants.find((id) => id !== userId) || ""
                      )}
                      active={selectedConvId === conv.id}
                      onSelect={() => onSelectConv(conv.id)}
                      onHide={() => onHide(conv.id)}
                      onDelete={() => onDelete(conv.id)}
                      onMute={() => onMute(conv.id)}
                      onBlock={() => onBlock(conv.id)}
                    />
                  ))
                ) : (
                  <div className="rounded-nkc border border-dashed border-nkc-border px-4 py-4 text-xs text-nkc-muted">
                    아직 대화가 없습니다.
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : (
          <section className="space-y-3">
            <h2 className="text-xs uppercase tracking-widest text-nkc-muted">Friends</h2>
            <div className="space-y-2">
              {visibleFriends.length ? (
                visibleFriends.map((friend) => (
                  <button
                    key={friend.id}
                    onClick={() => onFriendChat(friend.id)}
                    className="flex w-full items-start gap-3 rounded-nkc border border-transparent px-3 py-3.5 text-left hover:bg-nkc-panelMuted"
                  >
                    <Avatar name={friend.displayName} avatarRef={friend.avatarRef} size={42} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-nkc-text line-clamp-1">
                        {friend.displayName}
                      </div>
                      <div className="text-xs text-nkc-muted line-clamp-1">{friend.status}</div>
                    </div>
                    <div className="flex items-start gap-2">
                      {friend.isFavorite ? (
                        <span className="text-[11px] text-nkc-muted">즐겨찾기</span>
                      ) : (
                        <span className="text-[11px] text-nkc-muted">친구</span>
                      )}
                      <FriendOverflowMenu
                        isFavorite={friend.isFavorite}
                        onChat={() => onFriendChat(friend.id)}
                        onViewProfile={() => onFriendViewProfile(friend.id)}
                        onToggleFavorite={() => onFriendToggleFavorite(friend.id)}
                        onHide={() => onFriendHide(friend.id)}
                        onDelete={() => onFriendDelete(friend.id)}
                        onBlock={() => onFriendBlock(friend.id)}
                      />
                    </div>
                  </button>
                ))
              ) : (
                <div className="rounded-nkc border border-dashed border-nkc-border px-4 py-4 text-xs text-nkc-muted">
                  표시할 친구가 없습니다.
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

type ConversationRowProps = {
  conv: Conversation;
  friend?: UserProfile;
  active: boolean;
  onSelect: () => void;
  onHide: () => void;
  onDelete: () => void;
  onMute: () => void;
  onBlock: () => void;
};

function ConversationRow({
  conv,
  friend,
  active,
  onSelect,
  onHide,
  onDelete,
  onMute,
  onBlock,
}: ConversationRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`flex w-full items-start gap-3 rounded-nkc border px-3 py-3.5 text-left transition ${
        active
          ? "border-nkc-accent/40 bg-nkc-panelMuted"
          : "border-transparent hover:bg-nkc-panelMuted"
      }`}
    >
      <Avatar name={friend?.displayName || conv.name} avatarRef={friend?.avatarRef} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-semibold text-nkc-text line-clamp-1">
            {conv.name}
          </div>
          <span className="text-xs text-nkc-muted">{formatTime(conv.lastTs)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xs text-nkc-muted line-clamp-2">
            {conv.lastMessage}
          </span>
          {conv.unread > 0 ? (
            <span className="rounded-full bg-nkc-accent/20 px-2 py-0.5 text-[11px] text-nkc-accent">
              {conv.unread}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-nkc-muted">
          {conv.muted ? <span>음소거</span> : null}
          {conv.blocked ? <span>차단</span> : null}
        </div>
      </div>
      <div
        className="pt-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <OverflowMenu onHide={onHide} onDelete={onDelete} onMute={onMute} onBlock={onBlock} />
      </div>
    </div>
  );
}
