import * as Tabs from "@radix-ui/react-tabs";
import { Settings } from "lucide-react";
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
  onOpenSettings: () => void;
};

const detailsByName: Record<
  string,
  { status: string; lastSeen: string; note: string }
> = {
  "테스트 친구": {
    status: "테스트 세션 진행 중",
    lastSeen: "방금 전",
    note: "테스트용 프로필입니다. 상태/메모/탭 UI 확인용으로 사용하세요.",
  },
  민지: {
    status: "온라인",
    lastSeen: "2분 전",
    note: "오늘도 NKC에서 대화를 이어가요.",
  },
  리드: {
    status: "업무 중",
    lastSeen: "10분 전",
    note: "점심 이후 회의가 있습니다.",
  },
  진아: {
    status: "자리 비움",
    lastSeen: "1시간 전",
    note: "잠시 자리를 비웠어요.",
  },
};

export default function RightPanel({
  open,
  tab,
  onTabChange,
  conversation,
  friendProfile,
  onOpenSettings,
}: RightPanelProps) {
  if (!open) return null;

  const displayName = friendProfile?.displayName || conversation?.name || "";
  const detail = displayName ? detailsByName[displayName] : undefined;

  return (
    <aside className="hidden h-full w-[320px] rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft lg:block">
      <Tabs.Root value={tab} onValueChange={(value) => onTabChange(value as any)}>
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
                  <div className="text-xs text-nkc-muted">
                    상태: {detail?.status || "활성"}
                  </div>
                </div>
              </div>
              <div className="text-xs text-nkc-muted">
                마지막 활동: {detail?.lastSeen || "최근 접속"}
              </div>
              <div className="text-xs text-nkc-muted">
                {detail?.note || "상세 정보가 준비되어 있습니다."}
              </div>
            </div>
          ) : (
            <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-sm text-nkc-muted">
              대화를 선택하면 상세 정보를 볼 수 있습니다.
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="media" className="mt-4">
          <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-sm text-nkc-muted">
            첨부 미디어는 로컬에서 복호화된 상태로 보여집니다.
          </div>
        </Tabs.Content>

        <Tabs.Content value="settings" className="mt-4 space-y-3">
          <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4 text-sm text-nkc-muted">
            채팅별 알림과 차단 설정을 관리하세요.
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