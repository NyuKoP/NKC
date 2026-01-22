import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Eye, EyeOff, UserPlus } from "lucide-react";

type FriendAddDialogProps = {
  open: boolean;
  myCode: string;
  onOpenChange: (open: boolean) => void;
  onCopyCode: () => Promise<void>;
  onAdd: (payload: { code: string; psk?: string }) => Promise<{ ok: boolean; error?: string }>;
};

export default function FriendAddDialog({
  open,
  myCode,
  onOpenChange,
  onCopyCode,
  onAdd,
}: FriendAddDialogProps) {
  const [code, setCode] = useState("");
  const [psk, setPsk] = useState("");
  const [showPsk, setShowPsk] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setPsk("");
      setShowPsk(false);
      setError("");
      setBusy(false);
    }
  }, [open]);

  const handleAdd = async () => {
    setError("");
    setBusy(true);
    try {
      const result = await onAdd({ code, psk: psk.trim() ? psk : undefined });
      if (!result.ok) {
        setError(result.error || "친구 추가에 실패했습니다.");
        return;
      }
      setCode("");
      setPsk("");
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
                onClick={() => setShowPsk(false)}
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

            <label className="text-sm text-nkc-muted">
              친구 코드
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NCK- 또는 NKC1-/NKI1-..."
              />
            </label>

            <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-3 text-xs text-nkc-muted">
              PSK는 선택사항입니다. 친구와 미리 공유한 경우 입력하세요.
            </div>

            <label className="text-sm text-nkc-muted">
              PSK
              <div className="mt-2 flex items-center gap-2">
                <input
                  type={showPsk ? "text" : "password"}
                  value={psk}
                  onChange={(event) => setPsk(event.target.value)}
                  className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                  placeholder="PSK (선택)"
                />
                <button
                  type="button"
                  onClick={() => setShowPsk((prev) => !prev)}
                  className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                >
                  {showPsk ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
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
