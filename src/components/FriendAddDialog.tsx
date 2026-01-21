import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Eye, EyeOff, UserPlus } from "lucide-react";

type FriendAddDialogProps = {
  open: boolean;
  myCode: string;
  canShowMyCode: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyCode: () => Promise<void>;
  onAdd: (payload: { code: string; psk?: string }) => Promise<{ ok: boolean; error?: string }>;
};

export default function FriendAddDialog({
  open,
  myCode,
  canShowMyCode,
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
          <Dialog.Title className="text-base font-semibold text-nkc-text">
            친구 추가
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            친구 코드(NKC1-...)를 교환해 서로를 추가하세요.
          </Dialog.Description>

          <div className="mt-4 grid gap-3">
            <label className="text-sm">
              내 친구 코드
              <div className="mt-2 flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                <input
                  value={canShowMyCode ? myCode : ""}
                  readOnly
                  autoComplete="off"
                  className="w-full bg-transparent text-sm text-nkc-text focus:outline-none"
                  placeholder={canShowMyCode ? "코드를 생성하는 중..." : "Primary 디바이스에서만 표시됩니다."}
                />
                <button
                  onClick={onCopyCode}
                  className="flex items-center gap-1 rounded-nkc border border-nkc-border px-2 py-1 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canShowMyCode || !myCode}
                  title={canShowMyCode ? undefined : "이 작업은 Primary 디바이스에서만 가능합니다."}
                >
                  <Copy size={12} />
                  복사
                </button>
              </div>
              {!canShowMyCode ? (
                <div className="mt-2 text-xs text-nkc-muted">
                  이 작업은 Primary 디바이스에서만 가능합니다.
                </div>
              ) : null}
            </label>

            <label className="text-sm">
              친구 코드
              <textarea
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                placeholder="NKC1-..."
                rows={3}
              />
            </label>

            <label className="text-sm">
              PSK (선택)
              <div className="mt-2 flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                <input
                  value={psk}
                  onChange={(event) => setPsk(event.target.value)}
                  type={showPsk ? "text" : "password"}
                  className="w-full bg-transparent text-sm text-nkc-text focus:outline-none"
                  placeholder="추가 암호 (선택)"
                />
                <button
                  type="button"
                  onClick={() => setShowPsk((prev) => !prev)}
                  className="rounded-nkc border border-nkc-border px-2 py-1 text-xs text-nkc-text hover:bg-nkc-panelMuted"
                >
                  {showPsk ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
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
              disabled={!code.trim() || busy}
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

