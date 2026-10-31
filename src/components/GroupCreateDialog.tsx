import { useAppStore } from "../app/store";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { UserProfile } from "../db/repo";
import Avatar from "./Avatar";

type GroupCreateDialogProps = {
  open: boolean;
  friends: UserProfile[];
  onOpenChange: (open: boolean) => void;
  onCreate: (payload: { name: string; memberIds: string[]; avatarFile?: File | null }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
};

export default function GroupCreateDialog({
  open,
  friends,
  onOpenChange,
  onCreate,
}: GroupCreateDialogProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setSearch("");
      setSelected(new Set());
      setAvatarFile(null);
      setError("");
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);

      return;
    }

    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [avatarFile]);

  const visibleFriends = useMemo(() => {
    const term = search.trim().toLowerCase();

    return friends
      .filter(
        (friend) =>
          friend.friendStatus !== "hidden" &&
          friend.friendStatus !== "blocked" &&
          friend.friendStatus !== "deleted"
      )
      .filter((friend) =>
        term ? friend.displayName.toLowerCase().includes(term) : true
      );
  }, [friends, search]);

  const selectedNames = useMemo(
    () =>
      friends
        .filter((friend) => selected.has(friend.id))
        .map((friend) => friend.displayName)
        .filter(Boolean),
    [friends, selected]
  );

  const defaultName = selectedNames.join(", ");

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setAvatarFile(file);
    event.target.value = "";
  };

  const toggleMember = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  const handleCreate = async () => {
    if (submitting.current) return;
    setError("");
    const trimmed = name.trim();

    if (selected.size === 0) {
      setError(t("초대할 친구를 선택해주세요.", "Select at least one friend to invite."));

      return;
    }

    const finalName = trimmed || defaultName || t("그룹", "Group");
    submitting.current = true;
    setBusy(true);

    try {
      const result = await onCreate({
        name: finalName,
        memberIds: Array.from(selected),
        avatarFile,
      });

      if (!result.ok) {
        console.warn("Group creation rejected", result.error);
        setError(t("그룹 만들기에 실패했어요.", "Could not create the group. Please try again."));

        return;
      }

      onOpenChange(false);
    } catch (createError) {
      console.error("Group create failed", createError);
      setError(t("그룹 만들기에 실패했어요.", "Could not create the group. Please try again."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={value => { if (!submitting.current) onOpenChange(value); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="nkc-modal-overlay fixed inset-0 bg-black/60" />
        <Dialog.Content className="nkc-modal-content fixed left-1/2 top-1/2 flex max-h-[calc(100dvh-32px)] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft">
          <header className="shrink-0">
          <Dialog.Title className="text-base font-semibold text-nkc-text">
            {t("그룹 만들기", "Create group")}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            {t("그룹 이름을 정하고 초대할 친구를 선택하세요.", "Name your group and select friends to invite.")}</Dialog.Description>
          </header>

          <div className="mt-4 grid min-h-0 gap-3 overflow-y-auto">
            <div className="flex items-center gap-4 rounded-nkc border border-nkc-border bg-nkc-panelMuted px-3 py-3 text-sm">
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt={t("그룹 이미지 미리보기", "Group image preview")}
                  className="h-12 w-12 rounded-full border border-nkc-border object-cover"
                />
              ) : (
                <Avatar name={name || t("그룹", "Group")} size={48} className="shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-xs text-nkc-muted">{t("그룹 이미지", "Group image")}</div>
                <div className="text-sm font-medium text-nkc-text line-clamp-1">
                  {avatarFile ? avatarFile.name : t("선택된 파일 없음", "No file selected")}
                </div>
              </div>
              <label className="ml-auto shrink-0">
                <span className="inline-flex items-center rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-1.5 text-xs font-medium text-nkc-text hover:bg-nkc-panelMuted">
                  {avatarFile ? t("이미지 변경", "Change image") : t("파일 선택", "Choose file")}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="sr-only"
                  onChange={handleAvatarChange}
                />
              </label>
            </div>
            <label className="text-sm">
              {t("그룹 이름", "Group name")}<input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder={defaultName || t("새 그룹", "New group")}
              />
            </label>
            <label className="text-sm">
              {t("친구 검색", "Search friends")}<input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder={t("이름을 입력하세요", "Type a name")}
              />
            </label>
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-2 text-sm">
              {visibleFriends.length ? (
                visibleFriends.map((friend) => (
                  <label
                    key={friend.id}
                    className="flex items-center gap-3 rounded-nkc px-2 py-2 hover:bg-nkc-panelMuted"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(friend.id)}
                      onChange={() => toggleMember(friend.id)}
                    />
                    <Avatar
                      name={friend.displayName}
                      colorKey={friend.id}
                      avatarRef={friend.avatarRef}
                      size={32}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-nkc-text line-clamp-1">
                        {friend.displayName}
                      </div>
                      <div className="text-xs text-nkc-muted line-clamp-1">
                        {friend.status}
                      </div>
                    </div>
                  </label>
                ))
              ) : (
                <div className="rounded-nkc border border-dashed border-nkc-border px-3 py-3 text-xs text-nkc-muted">
                  {t("표시할 친구가 없습니다.", "No friends to show.")}</div>
              )}
            </div>
          </div>

          {error ? <div className="mt-3 text-xs nkc-error">{error}</div> : null}

          <div className="mt-5 flex shrink-0 justify-end gap-2">
            <Dialog.Close asChild>
              <button disabled={busy} className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50">
                {t("닫기", "Close")}</button>
            </Dialog.Close>
            <button
              onClick={handleCreate}
              className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-accentText disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selected.size === 0 || busy}
            >
              {t("만들기", "Create")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
