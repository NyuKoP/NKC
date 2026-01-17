import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { KeyRound, Lock, ShieldAlert } from "lucide-react";
import type { UserProfile } from "../db/repo";
import { defaultPrivacyPrefs, getPrivacyPrefs, setPrivacyPrefs } from "../security/preferences";
import Avatar from "./Avatar";

const themeOptions = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
] as const;

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserProfile;
  onSaveProfile: (payload: {
    displayName: string;
    status: string;
    theme: "dark" | "light";
  }) => Promise<void>;
  onUploadPhoto: (file: File) => Promise<void>;
  onLock: () => void;
  pinEnabled: boolean;
  onSetPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  onDisablePin: () => Promise<void>;
  onOpenRecovery: () => void;
  hiddenFriends: UserProfile[];
  blockedFriends: UserProfile[];
  onUnhideFriend: (id: string) => Promise<void>;
  onUnblockFriend: (id: string) => Promise<void>;
  onLogout: () => void;
  onWipe: () => void;
};

export default function SettingsDialog({
  open,
  onOpenChange,
  user,
  onSaveProfile,
  onUploadPhoto,
  onLock,
  pinEnabled,
  onSetPin,
  onDisablePin,
  onOpenRecovery,
  hiddenFriends,
  blockedFriends,
  onUnhideFriend,
  onUnblockFriend,
  onLogout,
  onWipe,
}: SettingsDialogProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState(user.status);
  const [theme, setTheme] = useState<"dark" | "light">(user.theme);
  const [pinDraft, setPinDraft] = useState("");
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState("");
  const [privacyPrefs, setPrivacyPrefsState] = useState(defaultPrivacyPrefs);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    setDisplayName(user.displayName);
    setStatus(user.status);
    setTheme(user.theme);
  }, [user]);

  useEffect(() => {
    if (pinEnabled) {
      setPinPending(false);
      setPinDraft("");
      setPinError("");
    }
  }, [pinEnabled]);

  useEffect(() => {
    if (!open) return;
    getPrivacyPrefs()
      .then(setPrivacyPrefsState)
      .catch((error) => console.error("Failed to load privacy prefs", error));
  }, [open]);

  useEffect(() => {
    if (!saveMessage) return;
    const timer = window.setTimeout(() => setSaveMessage(""), 2000);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 h-[80vh] w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
          <Dialog.Title className="text-lg font-semibold">NKC 설정</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            프로필과 보안 설정은 로컬 금고에 암호화되어 저장됩니다.
          </Dialog.Description>

          <div className="mt-6 grid gap-6">
            <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
              <h3 className="text-sm font-semibold text-nkc-text">프로필</h3>
              <div className="mt-4 grid gap-4 md:grid-cols-[auto,1fr]">
                <div className="flex flex-col items-center gap-3">
                  <Avatar name={displayName} avatarRef={user.avatarRef} size={64} />
                  <label className="cursor-pointer rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel">
                    사진 업로드
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) =>
                        event.target.files?.[0] && onUploadPhoto(event.target.files[0])
                      }
                    />
                  </label>
                </div>
                <div className="grid gap-4">
                  <label className="text-sm">
                    표시 이름
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    상태 메시지
                    <input
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                      className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                    />
                  </label>
                </div>
              </div>
            </section>

            <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-nkc-text">개인정보 보호</h3>
                <button
                  onClick={onLock}
                  className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                >
                  <Lock size={14} /> 잠금
                </button>
              </div>
              <div className="mt-4 grid gap-3">
                <label className="flex items-center justify-between text-sm">
                  <span>PIN 잠금</span>
                  <input
                    type="checkbox"
                    checked={pinEnabled || pinPending}
                    onChange={async (event) => {
                      const next = event.target.checked;
                      setPinError("");
                      if (!next) {
                        setPinPending(false);
                        setPinDraft("");
                        if (pinEnabled) {
                          await onDisablePin();
                        }
                        return;
                      }
                      setPinPending(true);
                    }}
                  />
                </label>
                {pinEnabled || pinPending ? (
                  <div className="grid gap-2">
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="\\d*"
                      maxLength={8}
                      value={pinDraft}
                      onChange={(event) => setPinDraft(event.target.value)}
                      placeholder="4-8자리"
                      className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm"
                    />
                    <button
                      onClick={async () => {
                        setPinError("");
                        const result = await onSetPin(pinDraft);
                        if (!result.ok) {
                          setPinError(result.error || "PIN 설정에 실패했습니다.");
                        }
                      }}
                      className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!pinDraft}
                    >
                      PIN 저장
                    </button>
                  </div>
                ) : null}
                {pinError ? (
                  <div className="text-xs text-red-300">{pinError}</div>
                ) : null}
                <label className="flex items-center justify-between text-sm">
                  <span>읽음 확인</span>
                  <input
                    type="checkbox"
                    checked={privacyPrefs.readReceipts}
                    onChange={async (event) => {
                      const next = { ...privacyPrefs, readReceipts: event.target.checked };
                      setPrivacyPrefsState(next);
                      try {
                        await setPrivacyPrefs(next);
                      } catch (error) {
                        console.error("Failed to save read receipts", error);
                      }
                    }}
                  />
                </label>
                <label className="flex items-center justify-between text-sm">
                  <span>입력 중 표시</span>
                  <input
                    type="checkbox"
                    checked={privacyPrefs.typingIndicator}
                    onChange={async (event) => {
                      const next = { ...privacyPrefs, typingIndicator: event.target.checked };
                      setPrivacyPrefsState(next);
                      try {
                        await setPrivacyPrefs(next);
                      } catch (error) {
                        console.error("Failed to save typing indicator", error);
                      }
                    }}
                  />
                </label>
                <label className="flex items-center justify-between text-sm">
                  <span>링크 미리보기</span>
                  <input
                    type="checkbox"
                    checked={privacyPrefs.linkPreviews}
                    onChange={async (event) => {
                      const next = { ...privacyPrefs, linkPreviews: event.target.checked };
                      setPrivacyPrefsState(next);
                      try {
                        await setPrivacyPrefs(next);
                      } catch (error) {
                        console.error("Failed to save link previews", error);
                      }
                    }}
                  />
                </label>
                <button
                  onClick={onOpenRecovery}
                  className="flex w-fit items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                >
                  <KeyRound size={14} />
                  복구키 관리
                </button>
              </div>
            </section>

            <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
              <h3 className="text-sm font-semibold text-nkc-text">테마</h3>
              <div className="mt-3 flex flex-wrap gap-3">
                {themeOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setTheme(option.value)}
                    className={`rounded-nkc border px-4 py-2 text-xs ${
                      theme === option.value
                        ? "border-nkc-accent bg-nkc-panel text-nkc-text"
                        : "border-nkc-border text-nkc-muted hover:bg-nkc-panel"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
              <h3 className="text-sm font-semibold text-nkc-text">친구 관리</h3>
              <div className="mt-4 grid gap-4 text-sm">
                <div>
                  <div className="text-xs text-nkc-muted">숨김 목록</div>
                  {hiddenFriends.length ? (
                    <div className="mt-2 grid gap-2">
                      {hiddenFriends.map((friend) => (
                        <div
                          key={friend.id}
                          className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                        >
                          <span className="text-nkc-text">{friend.displayName}</span>
                          <button
                            onClick={() => onUnhideFriend(friend.id)}
                            className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                          >
                            표시
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                      숨긴 친구가 없습니다.
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-nkc-muted">차단 목록</div>
                  {blockedFriends.length ? (
                    <div className="mt-2 grid gap-2">
                      {blockedFriends.map((friend) => (
                        <div
                          key={friend.id}
                          className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                        >
                          <span className="text-nkc-text">{friend.displayName}</span>
                          <button
                            onClick={() => onUnblockFriend(friend.id)}
                            className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                          >
                            차단 해제
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                      차단한 친구가 없습니다.
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-nkc border border-red-500/30 bg-red-500/10 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-red-200">위험 영역</h3>
                  <p className="mt-1 text-xs text-red-200/70">
                    로그아웃 또는 데이터 삭제는 복구키 없이는 되돌릴 수 없습니다.
                  </p>
                </div>
                <ShieldAlert className="text-red-300" size={18} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={onLogout}
                  className="rounded-nkc border border-red-500/40 px-3 py-2 text-xs text-red-200 hover:bg-red-500/20"
                >
                  로그아웃
                </button>
                <button
                  onClick={onWipe}
                  className="rounded-nkc border border-red-500/40 px-3 py-2 text-xs text-red-200 hover:bg-red-500/20"
                >
                  데이터 삭제
                </button>
              </div>
            </section>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                닫기
              </button>
            </Dialog.Close>
            <button
              onClick={async () => {
                try {
                  await onSaveProfile({ displayName, status, theme });
                  setSaveMessage("저장했습니다");
                } catch (error) {
                  console.error("Failed to save profile", error);
                }
              }}
              className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
            >
              저장
            </button>
          </div>
          {saveMessage ? (
            <div className="mt-2 text-right text-xs text-nkc-muted">{saveMessage}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
