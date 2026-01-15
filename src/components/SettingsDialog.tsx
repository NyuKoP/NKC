import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { KeyRound, Lock, RefreshCcw, ShieldAlert } from "lucide-react";
import type { UserProfile } from "../db/repo";
import { generateRecoveryKey } from "../crypto/vault";
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
  onRotateKey: (newKey: string, onProgress: (value: number) => void) => Promise<void>;
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
  onRotateKey,
  onLogout,
  onWipe,
}: SettingsDialogProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState(user.status);
  const [theme, setTheme] = useState<"dark" | "light">(user.theme);
  const [newKey, setNewKey] = useState("");
  const [rotateProgress, setRotateProgress] = useState(0);

  useEffect(() => {
    setDisplayName(user.displayName);
    setStatus(user.status);
    setTheme(user.theme);
  }, [user]);

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
                <h3 className="text-sm font-semibold text-nkc-text">보안</h3>
                <button
                  onClick={onLock}
                  className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                >
                  <Lock size={14} /> 잠금
                </button>
              </div>
              <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel p-4 text-xs text-nkc-muted">
                복구키 변경은 모든 레코드를 재암호화합니다. 작업 중에는 앱을 닫지 마세요.
              </div>
              <div className="mt-4 grid gap-3">
                <label className="text-sm">
                  새 복구키
                  <textarea
                    value={newKey}
                    onChange={(event) => setNewKey(event.target.value)}
                    placeholder="NKC-XXXX-XXXX-XXXX-XXXX"
                    className="mt-2 h-20 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => setNewKey(await generateRecoveryKey())}
                    className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel"
                  >
                    <RefreshCcw size={14} />
                    새 키 생성
                  </button>
                  <button
                    onClick={() => newKey && onRotateKey(newKey, setRotateProgress)}
                    className="flex items-center gap-2 rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg"
                  >
                    <KeyRound size={14} />
                    키 회전
                  </button>
                </div>
                {rotateProgress ? (
                  <div className="text-xs text-nkc-muted">진행률 {rotateProgress}%</div>
                ) : null}
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
                await onSaveProfile({ displayName, status, theme });
              }}
              className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
            >
              저장
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
