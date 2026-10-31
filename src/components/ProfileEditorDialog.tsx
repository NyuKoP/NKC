import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { UserProfile } from "../db/repo";
import { useAppStore } from "../app/store";
import { inspectAvatarImageFile } from "../security/mediaPolicy";
import Avatar from "./Avatar";
import AvatarImageEditorDialog from "./AvatarImageEditorDialog";
import { CloseIcon, EditIcon } from "./icons/Icons";

type ProfileEditorDialogProps = {
  open: boolean;
  user: UserProfile;
  onOpenChange: (open: boolean) => void;
  onSave: (profile: { displayName: string; status: string; avatarFile?: File }) => Promise<void>;
};

export default function ProfileEditorDialog({
  open,
  user,
  onOpenChange,
  onSave,
}: ProfileEditorDialogProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState((user.status ?? "").slice(0, 100));
  const [avatarFile, setAvatarFile] = useState<File>();
  const [avatarEditFile, setAvatarEditFile] = useState<File>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const presenceLabel =
    user.presence?.status === "idle"
      ? t("자리 비움", "Idle")
      : user.presence?.status === "dnd"
        ? t("방해 금지", "Do not disturb")
        : user.presence?.status === "offline"
          ? t("오프라인", "Offline")
          : t("온라인", "Online");

  useEffect(
    () => () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    },
    [avatarPreviewUrl]
  );

  const save = async () => {
    const name = displayName.trim();

    if (!name || busy) return;
    setBusy(true);
    setError("");

    try {
      await onSave({
        displayName: name,
        status: status.trim().slice(0, 100),
        avatarFile,
      });
      onOpenChange(false);
    } catch (saveError) {
      console.error("Failed to save profile", saveError);
      setError(t("프로필 저장에 실패했습니다.", "Failed to save profile."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="profile-editor-dialog"
          className="fixed left-1/2 top-1/2 z-[71] flex max-h-[92vh] w-[calc(100vw-32px)] max-w-[700px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-nkc-divider bg-nkc-panel shadow-2xl outline-none"
        >
          <header className="flex items-start justify-between gap-4 border-b border-nkc-divider px-6 py-5 sm:px-7">
            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-nkc-brandAccent">
                {t("내 프로필", "My profile")}
              </div>
              <Dialog.Title className="text-xl font-bold tracking-[-0.02em] text-nkc-text">
                {t("프로필 편집", "Edit profile")}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-nkc-muted">
                {t("친구에게 보여줄 이름, 사진과 상태 메시지를 설정하세요.", "Choose the name, photo, and status your friends will see.")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              type="button"
              aria-label={t("닫기", "Close")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-nkc-muted transition-colors hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
            >
              <CloseIcon className="h-5 w-5" />
            </Dialog.Close>
          </header>

          <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-6 px-6 py-6 sm:px-7 md:order-last">
              <label className="block text-sm font-semibold text-nkc-text">
                <span className="flex items-center justify-between gap-3">
                  {t("표시 이름", "Display name")}
                  <span className="text-xs font-normal text-nkc-muted">{displayName.length}/64</span>
                </span>
                <input
                  data-testid="profile-editor-display-name"
                  value={displayName}
                  maxLength={64}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-nkc-divider bg-nkc-surface px-3.5 py-3 text-sm font-normal text-nkc-text outline-none transition-shadow placeholder:text-nkc-muted focus:border-nkc-accent focus:ring-2 focus:ring-nkc-focusRing"
                />
              </label>

              <label className="block text-sm font-semibold text-nkc-text">
                <span className="flex items-center justify-between gap-3">
                  {t("상태 메시지", "Status message")}
                  <span
                    data-testid="profile-editor-status-count"
                    className="text-xs font-normal text-nkc-muted"
                  >
                    {status.length}/100
                  </span>
                </span>
                <textarea
                  data-testid="profile-editor-status"
                  value={status}
                  maxLength={100}
                  rows={3}
                  onChange={(event) => setStatus(event.target.value)}
                  placeholder={t("지금의 상태를 짧게 알려주세요.", "Share a short update.")}
                  className="mt-2 w-full resize-none rounded-xl border border-nkc-divider bg-nkc-surface px-3.5 py-3 text-sm font-normal leading-6 text-nkc-text outline-none transition-shadow placeholder:text-nkc-muted focus:border-nkc-accent focus:ring-2 focus:ring-nkc-focusRing"
                />
              </label>
            </div>

            <aside className="border-t border-nkc-divider bg-nkc-panelMuted px-6 py-6 md:order-first md:border-r md:border-t-0">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-nkc-text">
                  {t("프로필 변경", "Edit profile")}
                </div>
                <span className="rounded-full bg-nkc-selected px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-nkc-brandPrimary">
                  {t("미리보기", "Preview")}
                </span>
              </div>
              <section
                data-testid="profile-editor-preview"
                className="rounded-2xl border border-nkc-divider bg-nkc-surface p-6 shadow-lg"
              >
                <div className="flex items-center gap-4">
                  <label
                    title={t("프로필 사진 변경", "Change profile photo")}
                    className="group relative shrink-0 cursor-pointer rounded-full ring-1 ring-nkc-divider ring-offset-4 ring-offset-nkc-surface focus-within:ring-2 focus-within:ring-nkc-focusRing"
                  >
                    {avatarPreviewUrl ? (
                      <img
                        src={avatarPreviewUrl}
                        alt=""
                        data-testid="profile-editor-avatar-preview"
                        className="h-24 w-24 rounded-full object-cover"
                      />
                    ) : (
                      <Avatar
                        name={displayName || user.displayName}
                        colorKey={user.id}
                        avatarRef={user.avatarRef}
                        size={96}
                      />
                    )}
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-full bg-black/65 text-[11px] font-bold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <EditIcon className="h-4 w-4" />
                      {t("사진 변경", "Change")}
                    </span>
                    <span
                      aria-label={t("온라인", "Online")}
                      className="pointer-events-none absolute bottom-1 right-0 z-10 h-4 w-4 rounded-full border-[3px] border-nkc-surface bg-nkc-success"
                    />
                    <input
                      data-testid="profile-editor-photo"
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];

                        if (!file) return;
                        setError("");
                        void inspectAvatarImageFile(file)
                          .then(() => setAvatarEditFile(file))
                          .catch((selectError) => {
                            console.error("Failed to select profile image", selectError);
                            setError(t("지원되는 이미지 파일을 선택해주세요.", "Choose a supported image file."));
                          });
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xl font-bold tracking-[-0.02em] text-nkc-text">
                      {displayName.trim() || user.displayName}
                    </div>
                    <div
                      title={status.trim() || presenceLabel}
                      className="mt-1.5 line-clamp-2 break-all whitespace-pre-wrap text-[13px] leading-5 text-nkc-muted"
                    >
                      {status.trim() || presenceLabel}
                    </div>
                  </div>
                </div>
              </section>
              <p className="mt-3 text-xs leading-5 text-nkc-muted">
                {t("프로필 변경 내용은 연결된 친구에게 동기화됩니다.", "Profile changes sync with connected friends.")}
              </p>
            </aside>
          </div>

          {error ? <div role="alert" className="border-t border-nkc-divider px-6 py-3 text-sm text-nkc-danger">{error}</div> : null}
          <footer className="flex justify-end gap-3 border-t border-nkc-divider bg-nkc-panel px-6 py-4 sm:px-7">
            <Dialog.Close
              type="button"
              disabled={busy}
              className="rounded-lg px-4 py-2.5 text-sm font-semibold text-nkc-text transition-colors hover:bg-nkc-hover focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-50"
            >
              {t("취소", "Cancel")}
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!displayName.trim() || busy}
              className="min-w-28 rounded-lg bg-nkc-accent px-5 py-2.5 text-sm font-semibold text-nkc-accentText transition-[filter,opacity] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-nkc-focusRing focus-visible:ring-offset-2 focus-visible:ring-offset-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t("저장 중…", "Saving…") : t("변경사항 저장", "Save changes")}
            </button>
          </footer>
          {avatarEditFile ? (
            <AvatarImageEditorDialog
              file={avatarEditFile}
              t={t}
              onCancel={() => setAvatarEditFile(undefined)}
              onApply={(file) => {
                setAvatarFile(file);
                setAvatarPreviewUrl(URL.createObjectURL(file));
                setAvatarEditFile(undefined);
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
