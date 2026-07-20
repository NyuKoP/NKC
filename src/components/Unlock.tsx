import { useEffect, useMemo, useState } from "react";
import { wipeVault } from "../db/repo";
import { clearSession as clearStoredSession } from "../security/session";
import AuthShell from "./auth/AuthShell";
import { LockIcon } from "./icons/Icons";

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
    <AuthShell testId="unlock-screen">
      <div className="mx-auto max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-nkc-selected text-2xl">
          <LockIcon className="h-7 w-7 text-nkc-accent" />
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">다시 오신 것을 환영합니다</h1>
        <p className="mt-2 text-sm leading-6 text-nkc-muted">
          이 기기의 NKC 금고를 열려면 PIN을 입력하세요.
        </p>

        <label className="mt-7 block text-left text-sm font-medium">
          PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="\\d*"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            className="nkc-auth-input mt-2 text-center text-lg tracking-[0.35em]"
            placeholder="4-8자리"
            autoFocus
            data-testid="unlock-pin-input"
          />
        </label>

        {retrySeconds ? (
          <div className="mt-2 text-left text-xs text-nkc-muted">
            다시 시도 가능: {retrySeconds}s
          </div>
        ) : null}
        {error ? <div className="mt-2 text-left text-xs text-red-300">{error}</div> : null}

        <button
          onClick={handleUnlock}
          className="mt-6 w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || retrySeconds > 0 || !pin}
          data-testid="unlock-submit-button"
        >
          {busy ? "로그인 중..." : "로그인"}
        </button>
        {reason === "not_set" && onUseStartKey ? (
          <button
            onClick={() => void onUseStartKey()}
            className="mt-3 w-full rounded-xl px-4 py-2.5 text-xs font-medium text-nkc-accent hover:bg-nkc-hover"
          >
            시작 키로 재설정
          </button>
        ) : null}
        <button
          onClick={handleReset}
          className="mt-1 w-full rounded-xl px-4 py-2.5 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
        >
          로컬 금고 초기화
        </button>
      </div>
    </AuthShell>
  );
}
