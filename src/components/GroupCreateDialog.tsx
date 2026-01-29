import { useEffect, useMemo, useState, type ChangeEvent } from "react";
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
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      .filter((friend) => friend.friendStatus !== "hidden" && friend.friendStatus !== "blocked")
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
    setError("");
    const trimmed = name.trim();
    if (selected.size === 0) {
      setError("초대할 친구를 선택해주세요.");
      return;
    }
    const finalName = trimmed || defaultName || "그룹";
    setBusy(true);
    try {
      const result = await onCreate({
        name: finalName,
        memberIds: Array.from(selected),
        avatarFile,
      });
      if (!result.ok) {
        setError(result.error || "그룹 만들기에 실패했어요.");
        return;
      }
      onOpenChange(false);
    } catch (createError) {
      console.error("Group create failed", createError);
      setError("그룹 만들기에 실패했어요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft">
          <Dialog.Title className="text-base font-semibold text-nkc-text">
            그룹 만들기
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            그룹 이름을 정하고 초대할 친구를 선택하세요.
          </Dialog.Description>

          <div className="mt-4 grid gap-3">
            <div className="flex items-center gap-4 rounded-nkc border border-nkc-border bg-nkc-panelMuted px-3 py-3 text-sm">
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt="그룹 이미지 미리보기"
                  className="h-12 w-12 rounded-full border border-nkc-border object-cover"
                />
              ) : (
                <Avatar name={name || "그룹"} size={48} className="shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-xs text-nkc-muted">그룹 이미지</div>
                <div className="text-sm font-medium text-nkc-text line-clamp-1">
                  {avatarFile ? avatarFile.name : "선택된 파일 없음"}
                </div>
              </div>
              <label className="ml-auto shrink-0">
                <span className="inline-flex items-center rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-1.5 text-xs font-medium text-nkc-text hover:bg-nkc-panelMuted">
                  {avatarFile ? "이미지 변경" : "파일 선택"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleAvatarChange}
                />
              </label>
            </div>
            <label className="text-sm">
              그룹 이름
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder={defaultName || "새 그룹"}
              />
            </label>
            <label className="text-sm">
              친구 검색
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="이름을 입력하세요"
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
                  표시할 친구가 없습니다.
                </div>
              )}
            </div>
          </div>

          {error ? <div className="mt-3 text-xs text-red-300">{error}</div> : null}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                닫기
              </button>
            </Dialog.Close>
            <button
              onClick={handleCreate}
              className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selected.size === 0 || busy}
            >
              만들기
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
