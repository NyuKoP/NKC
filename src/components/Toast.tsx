import type { ToastItem } from "./toastUtils";

type ToastProps = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
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
