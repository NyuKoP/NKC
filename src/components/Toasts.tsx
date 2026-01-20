import { useEffect, useRef } from "react";
import { useAppStore } from "../app/store";

export default function Toasts() {
  const toasts = useAppStore((state) => state.ui.toast);
  const removeToast = useAppStore((state) => state.removeToast);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const timerMap = timers.current;
    toasts.forEach((toast) => {
      if (!timerMap.has(toast.id)) {
        const id = window.setTimeout(() => {
          removeToast(toast.id);
          timerMap.delete(toast.id);
        }, 2500);
        timerMap.set(toast.id, id);
      }
    });

    return () => {
      timerMap.forEach((id) => window.clearTimeout(id));
      timerMap.clear();
    };
  }, [toasts, removeToast]);

  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 rounded-nkc border border-nkc-border bg-nkc-panel px-4 py-3 text-sm text-nkc-text shadow-soft"
        >
          <span className="flex-1">{toast.message}</span>
          {toast.actionLabel && toast.onAction ? (
            <button
              onClick={() => {
                toast.onAction?.();
                removeToast(toast.id);
              }}
              className="rounded-nkc border border-nkc-border px-3 py-1 text-xs text-nkc-text hover:bg-nkc-panelMuted"
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
