import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, UserPlus } from "lucide-react";

type FriendAddDialogProps = {
  open: boolean;
  myCode: string;
  myCodeHint?: string | null;
  routeResolveBusy?: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyCode: () => Promise<void>;
  onResolveRoute?: () => Promise<void>;
  onAdd: (payload: { code: string; psk?: string }) => Promise<{ ok: boolean; error?: string }>;
};

export default function FriendAddDialog({
  open,
  myCode,
  myCodeHint,
  routeResolveBusy = false,
  onOpenChange,
  onCopyCode,
  onResolveRoute,
  onAdd,
}: FriendAddDialogProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  const handleAdd = async () => {
    setError("");
    setBusy(true);
    try {
      const result = await onAdd({ code });
      if (!result.ok) {
        setError(result.error || "친구 추가에 실패했습니다.");
        return;
      }
      setCode("");
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
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-nkc-text">
            <UserPlus size={18} /> 친구 추가
          </Dialog.Title>

          <div className="mt-4 space-y-4">
            <label className="text-sm text-nkc-muted">
              내 코드
              <input
                value={myCode}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 font-mono text-sm text-nkc-text"
                placeholder="코드를 생성하는 중..."
                readOnly
              />
            </label>
            <button
              type="button"
              onClick={onCopyCode}
              className="inline-flex items-center gap-1 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!myCode}
            >
              <Copy size={14} />
              복사
            </button>
            {myCodeHint ? (
              <div className="space-y-2">
                <div className="text-xs text-amber-300">{myCodeHint}</div>
                {onResolveRoute ? (
                  <button
                    type="button"
                    onClick={() => void onResolveRoute()}
                    className="inline-flex items-center gap-1 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={routeResolveBusy}
                  >
                    {routeResolveBusy ? "경로 찾는 중..." : "경로 찾기"}
                  </button>
                ) : null}
              </div>
            ) : null}

            <label className="text-sm text-nkc-muted">
              친구 코드
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC1-... (선택: NKI1-...)"
              />
            </label>

            {error ? <div className="text-xs text-red-300">{error}</div> : null}

            <div className="flex justify-end gap-2">
              <Dialog.Close className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel">
                닫기
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void handleAdd()}
                className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                disabled={!code.trim() || busy}
              >
                {busy ? "추가 중..." : "친구 추가"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
