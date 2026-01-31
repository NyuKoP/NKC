import { useEffect, useMemo, useState } from "react";
import { wipeVault } from "../db/repo";
import { clearSession as clearStoredSession } from "../security/session";

export type UnlockResult = {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  reason?: "not_set" | "locked" | "mismatch" | "unavailable";
};

type UnlockProps = {
  onUnlock: (pin: string) => Promise<UnlockResult>;
  onUseStartKey?: () => void | Promise<void>;
};

export default function Unlock({ onUnlock, onUseStartKey }: UnlockProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<UnlockResult["reason"] | null>(null);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const retrySeconds = useMemo(() => {
    if (!retryAt) return 0;
    const diff = retryAt - now;
    return diff > 0 ? Math.ceil(diff / 1000) : 0;
  }, [now, retryAt]);

  const handleReset = async () => {
    const ok = window.confirm(
      "로컬 금고를 초기화할까요? 이 작업은 되돌릴 수 없습니다."
    );
    if (!ok) return;
    await clearStoredSession();
    await wipeVault();
    window.location.reload();
  };

  const handleUnlock = async () => {
    setError("");
    setReason(null);
    setBusy(true);
    try {
      const result = await onUnlock(pin);
      if (!result.ok) {
        setError(result.error || "PIN 형식이 올바르지 않습니다.");
        setReason(result.reason ?? null);
        if (result.retryAfterMs) {
          setRetryAt(Date.now() + result.retryAfterMs);
        }
      } else {
        setRetryAt(null);
      }
    } catch (unlockError) {
      console.error("PIN unlock failed", unlockError);
      setError("PIN 잠금 해제에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-nkc-bg px-6">
      <div className="w-full max-w-md rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <h1 className="text-xl font-semibold">NKC 잠금 해제</h1>
        <p className="mt-2 text-sm text-nkc-muted">
          PIN 잠금이 설정되어 있습니다. PIN을 잊었다면 시작 키로 재설정해야 합니다.
        </p>

        <label className="mt-6 text-sm">
          PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="\\d*"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
            placeholder="4-8자리"
          />
        </label>

        {retrySeconds ? (
          <div className="mt-2 text-xs text-nkc-muted">
            다시 시도 가능: {retrySeconds}s
          </div>
        ) : null}
        {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}

        <button
          onClick={handleUnlock}
          className="mt-6 w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || retrySeconds > 0 || !pin}
        >
          잠금 해제
        </button>
        {reason === "not_set" && onUseStartKey ? (
          <button
            onClick={() => void onUseStartKey()}
            className="mt-3 w-full rounded-nkc border border-nkc-border px-4 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
          >
            시작 키로 재설정
          </button>
        ) : null}
        <button
          onClick={handleReset}
          className="mt-3 w-full rounded-nkc border border-nkc-border px-4 py-2 text-xs text-nkc-muted hover:bg-nkc-panel"
        >
          로컬 금고 초기화
        </button>
      </div>
    </div>
  );
}
