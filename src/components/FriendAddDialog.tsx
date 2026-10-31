import { friendAddErrorMessage } from "./friendAddErrorMessage";
import { useAppStore } from "../app/store";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Loader2, UserPlus } from "lucide-react";

type FriendAddDialogProps = {
  open: boolean;
  myCode: string;
  myCodeHint?: string | null;
  myCodeLoading?: boolean;
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
  myCodeLoading = false,
  routeResolveBusy = false,
  onOpenChange,
  onCopyCode,
  onResolveRoute,
  onAdd,
}: FriendAddDialogProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const addInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setCode("");
      setError("");
    }
  }, [open]);

  const handleAdd = async () => {
    if (addInFlightRef.current) return;
    addInFlightRef.current = true;
    setError("");
    setBusy(true);

    try {
      const result = await onAdd({ code });

      if (!result.ok) {
        console.warn("Friend add rejected", result.error);
        setError(friendAddErrorMessage(result.error, language));

        return;
      }

      setCode("");
      onOpenChange(false);
    } catch (addError) {
      console.error("Friend add failed", addError);
      setError(t("친구 추가에 실패했습니다.", "Could not add this friend. Please try again."));
    } finally {
      addInFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nkc-modal-overlay fixed inset-0 bg-black/60" />
        <Dialog.Content className="nkc-modal-content fixed left-1/2 top-1/2 flex max-h-[calc(100dvh-32px)] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft">
          <Dialog.Title className="flex shrink-0 items-center gap-2 text-lg font-semibold text-nkc-text">
            <UserPlus size={18} /> {t("친구 추가", "Add friend")}</Dialog.Title>

          <div className="mt-4 min-h-0 space-y-4 overflow-y-auto">
            <label className="text-sm text-nkc-muted">
              {t("내 코드", "My code")}<input
                value={myCode}
                data-testid="friend-add-my-code"
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 font-mono text-sm text-nkc-text"
                placeholder={myCodeLoading ? t("경로 주소를 기다리는 중...", "Waiting for a route address...") : t("코드를 생성하는 중...", "Generating code...")}
                readOnly
              />
            </label>
            <button
              type="button"
              onClick={onCopyCode}
              className="inline-flex items-center gap-1 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!myCode || myCodeLoading}
            >
              {myCodeLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Copy size={14} />
              )}
              {myCodeLoading ? t("준비 중...", "Preparing...") : t("복사", "Copy")}
            </button>
            {myCodeHint ? (
              <div className="space-y-2">
                <div className="rounded-nkc border border-nkc-border/40 bg-nkc-panel/30 p-2.5 text-xs leading-relaxed text-nkc-muted">
                  <div className="flex gap-2">
                    {myCodeLoading ? (
                      <span className="mt-1 inline-flex h-2 w-2 shrink-0 rounded-full bg-nkc-warning animate-pulse" />
                    ) : null}
                    <p>{myCodeHint}</p>
                  </div>
                </div>
                {onResolveRoute ? (
                  <button
                    type="button"
                    onClick={() => void onResolveRoute()}
                    className="inline-flex items-center gap-1 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={routeResolveBusy}
                  >
                    {routeResolveBusy ? t("경로 찾는 중...", "Finding route...") : t("경로 찾기", "Find route")}
                  </button>
                ) : null}
              </div>
            ) : null}

            <label className="text-sm text-nkc-muted">
              {t("친구 코드", "Friend code")}<input
                value={code}
                data-testid="friend-add-code-input"
                onChange={(event) => setCode(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder={t("NKC1-... (선택: NKI1-...)", "NKC1-... (optional: NKI1-...)")}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>

          </div>
            {error ? <div className="mt-3 shrink-0 text-xs nkc-error" role="alert">{error}</div> : null}
            {busy ? (
              <div className="text-xs text-nkc-muted" role="status" aria-live="polite">
                {t("친구 코드를 확인하고 요청을 안전하게 준비하는 중입니다.", "Checking the friend code and securely preparing your request.")}</div>
            ) : null}

            <div className="mt-4 flex shrink-0 justify-end gap-2">
              <Dialog.Close
                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
              >
                {t("닫기", "Close")}</Dialog.Close>
              <button
                type="button"
                onClick={() => void handleAdd()}
                data-testid="friend-add-submit"
                className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-nkc-accentText disabled:opacity-50"
                disabled={!code.trim() || busy}
              >
                {busy ? t("추가 중...", "Adding...") : t("친구 추가", "Add friend")}
              </button>
            </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
