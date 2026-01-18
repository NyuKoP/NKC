import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../app/store";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onClose: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  return (
    <Dialog.Root open={open} onOpenChange={(value) => (!value ? onClose() : null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft">
          <Dialog.Title className="text-base font-semibold text-nkc-text">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            {message}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <button
              className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted"
              onClick={onClose}
            >
              {t("취소", "Cancel")}
            </button>
            <button
              className="rounded-nkc bg-red-500/10 px-4 py-2 text-sm text-red-400 hover:bg-red-500/20"
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {t("확인", "Confirm")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


