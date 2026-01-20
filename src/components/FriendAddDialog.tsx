import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, UserPlus } from "lucide-react";

type FriendAddDialogProps = {
  open: boolean;
  myId: string;
  onOpenChange: (open: boolean) => void;
  onCopyId: () => Promise<void>;
  onAdd: (friendId: string) => Promise<{ ok: boolean; error?: string }>;
};

export default function FriendAddDialog({
  open,
  myId,
  onOpenChange,
  onCopyId,
  onAdd,
}: FriendAddDialogProps) {
  const [friendId, setFriendId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setFriendId("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  const handleAdd = async () => {
    setError("");
    setBusy(true);
    try {
      const result = await onAdd(friendId);
      if (!result.ok) {
        setError(result.error || "친구 추가에 실패했습니다.");
        return;
      }
      setFriendId("");
      onOpenChange(false);
    } catch (addError) {
      console.error("Friend add failed", addError);
      setError("친구 추가에 실패했습니다.");
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
            친구 추가
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            내 ID를 공유하거나 친구 ID를 추가하세요.
          </Dialog.Description>

          <div className="mt-4 grid gap-3">
            <label className="text-sm">
              내 ID
              <div className="mt-2 flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                <input
                  value={myId}
                  readOnly
                  autoComplete="off"
                  className="w-full bg-transparent text-sm text-nkc-text focus:outline-none"
                  placeholder="ID 생성 중..."
                />
                <button
                  onClick={onCopyId}
                  className="flex items-center gap-1 rounded-nkc border border-nkc-border px-2 py-1 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!myId}
                >
                  <Copy size={12} />
                  복사
                </button>
              </div>
            </label>

            <label className="text-sm">
              친구 ID
              <input
                value={friendId}
                onChange={(event) => setFriendId(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NCK-XXXXXXXX"
              />
            </label>
          </div>

          {error ? <div className="mt-3 text-xs text-red-300">{error}</div> : null}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                닫기
              </button>
            </Dialog.Close>
            <button
              onClick={handleAdd}
              className="flex items-center gap-2 rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!friendId.trim() || busy}
            >
              <UserPlus size={14} />
              추가
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
