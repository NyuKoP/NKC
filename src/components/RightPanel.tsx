import * as Tabs from "@radix-ui/react-tabs";
import { Settings, UserPlus, UserX } from "lucide-react";
import type { Conversation, UserProfile } from "../db/repo";
import Avatar from "./Avatar";

const tabs = [
  { value: "about", label: "About" },
  { value: "media", label: "Media" },
  { value: "settings", label: "Settings" },
] as const;

type RightPanelProps = {
  open: boolean;
  tab: "about" | "media" | "settings";
  onTabChange: (tab: "about" | "media" | "settings") => void;
  conversation: Conversation | null;
  friendProfile?: UserProfile | null;
  currentUserId: string | null;
  profilesById: Record<string, UserProfile | undefined>;
  onOpenSettings: () => void;
  onInviteToGroup: (convId: string) => void;
  onLeaveGroup: (convId: string) => void;
};

const isTabValue = (value: string): value is RightPanelProps["tab"] =>
  value === "about" || value === "media" || value === "settings";

const detailsByName: Record<string, { status: string; lastSeen: string; note: string }> = {
  Demo: {
    status: "온라인",
    lastSeen: "방금 전",
    note: "상태/메모는 예시 데이터입니다.",
  },
};

const isGroupConversation = (conversation: Conversation | null) =>
  Boolean(conversation && (conversation.type === "group" || conversation.participants.length > 2));

export default function RightPanel({
  open,
  tab,
  onTabChange,
  conversation,
  friendProfile,
  currentUserId,
  profilesById,
  onOpenSettings,
  onInviteToGroup,
  onLeaveGroup,
}: RightPanelProps) {
  if (!open) return null;

  const displayName = friendProfile?.displayName || conversation?.name || "";
  const detail = displayName ? detailsByName[displayName] : undefined;
  const isGroup = isGroupConversation(conversation);
  const memberIds = conversation?.participants ?? [];

  const members = memberIds.map((id) => {
    const profile = profilesById[id];
    const fallbackName = id.slice(0, 8);
    return {
      id,
      name: profile?.displayName || (id === currentUserId ? "나" : fallbackName),
      avatarRef: profile?.avatarRef,
      status: profile?.status,
      isSelf: id === currentUserId,
    };
  });

  return (
    <aside className="hidden h-full w-[320px] rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft lg:block">
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (isTabValue(value)) onTabChange(value);
        }}
      >
        <Tabs.List className="grid grid-cols-3 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-xs">
          {tabs.map((item) => (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              className="rounded-nkc px-2 py-2 font-semibold text-nkc-muted data-[state=active]:bg-nkc-panel data-[state=active]:text-nkc-text"
            >
              {item.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="about" className="mt-4 space-y-4">
          {conversation ? (
            <div className="space-y-4 rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4">
              <div className="flex items-center gap-3">
                <Avatar
                  name={friendProfile?.displayName || conversation.name}
                  avatarRef={friendProfile?.avatarRef}
                  size={52}
                />
                <div>
                  <div className="text-sm font-semibold text-nkc-text">
                    {displayName || conversation.name}
                  </div>
                  <div className="text-xs text-nkc-muted">상태: {detail?.status || "활성"}</div>
                </div>
              </div>
              <div className="text-xs text-nkc-muted">마지막 활동: {detail?.lastSeen || "최근"}</div>
              <div className="text-xs text-nkc-muted">
                {detail?.note || "대화 정보가 여기에 표시됩니다."}
              </div>

              {isGroup ? (
                <>
                  <div className="border-t border-nkc-border pt-3">
                    <div className="text-xs font-semibold text-nkc-muted">Members ({members.length})</div>
                    <div className="mt-2 space-y-1">
                      {members.map((member) => (
                        <div key={member.id} className="flex items-center gap-2 rounded-nkc px-1 py-1.5">
                          <Avatar name={member.name} avatarRef={member.avatarRef} size={28} />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-nkc-text line-clamp-1">
                              {member.name}
                            </div>
                            {member.status ? (
                              <div className="text-[11px] text-nkc-muted line-clamp-1">{member.status}</div>
                            ) : null}
                          </div>
                          {member.isSelf ? (
                            <span className="ml-auto rounded-full border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted">
                              나
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onInviteToGroup(conversation.id)}
                      className="flex flex-1 items-center justify-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                    >
                      <UserPlus size={14} />
                      Invite
                    </button>
                    <button
                      type="button"
                      onClick={() => onLeaveGroup(conversation.id)}
                      className="flex flex-1 items-center justify-center gap-2 rounded-nkc border border-red-500/40 px-3 py-2 text-xs text-red-200 hover:bg-red-500/10"
                    >
                      <UserX size={14} />
                      Leave
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-sm text-nkc-muted">
              대화를 선택하면 상세 정보가 표시됩니다.
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="media" className="mt-4">
          <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-sm text-nkc-muted">
            첨부 미디어는 로컬에 암호화된 형태로 저장됩니다.
          </div>
        </Tabs.Content>

        <Tabs.Content value="settings" className="mt-4 space-y-3">
          <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4 text-sm text-nkc-muted">
            채팅 알림과 차단 설정을 관리합니다.
          </div>
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center justify-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
          >
            <Settings size={14} />
            전체 설정 열기
          </button>
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
