import type { UserProfile } from "../../../db/repo";
import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type FriendsSettingsProps = {
  t: Translate;
  onBack: () => void;
  hiddenFriends: UserProfile[];
  blockedFriends: UserProfile[];
  onUnhideFriend: (id: string) => void | Promise<void>;
  onUnblockFriend: (id: string) => void | Promise<void>;
};

export default function FriendsSettings({
  t,
  onBack,
  hiddenFriends,
  blockedFriends,
  onUnhideFriend,
  onUnblockFriend,
}: FriendsSettingsProps) {
  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader
        title={t("친구 관리", "Friend management")}
        backLabel={t("뒤로", "Back")}
        onBack={onBack}
      />
      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="grid gap-4 text-sm">
          <div>
            <div className="text-xs text-nkc-muted">{t("숨김 목록", "Hidden list")}</div>
            {hiddenFriends.length ? (
              <div className="mt-2 grid gap-2">
                {hiddenFriends.map((friend) => (
                  <div
                    key={friend.id}
                    className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                  >
                    <span className="text-nkc-text">{friend.displayName}</span>
                    <button
                      type="button"
                      onClick={() => void onUnhideFriend(friend.id)}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                    >
                      {t("복원", "Restore")}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                {t("숨김 친구가 없습니다.", "No hidden friends.")}
              </div>
            )}
          </div>

          <div>
            <div className="text-xs text-nkc-muted">{t("차단 목록", "Blocked list")}</div>
            {blockedFriends.length ? (
              <div className="mt-2 grid gap-2">
                {blockedFriends.map((friend) => (
                  <div
                    key={friend.id}
                    className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                  >
                    <span className="text-nkc-text">{friend.displayName}</span>
                    <button
                      type="button"
                      onClick={() => void onUnblockFriend(friend.id)}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                    >
                      {t("차단 해제", "Unblock")}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                {t("차단된 친구가 없습니다.", "No blocked friends.")}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

