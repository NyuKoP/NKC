import { useCallback, useEffect, useRef, useState } from "react";

export type ToastItem = {
  id: string;
  message: string;
};

type ToastProps = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
};

const TOAST_DURATION_MS = 2400;

export const useToastQueue = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string) => {
      const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setToasts((prev) => [...prev, { id, message }]);
      const timer = window.setTimeout(() => dismiss(id), TOAST_DURATION_MS);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  useEffect(() => {
    return () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  return { toasts, push, dismiss };
};

const Toast = ({ toasts, onDismiss }: ToastProps) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.message}</span>
          <button
            type="button"
            className="icon-button ghost"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
};

export default Toast;
