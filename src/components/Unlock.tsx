import { useAppStore } from "../app/store";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const inFlight = useRef(false);
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
      t("로컬 금고를 초기화할까요? 이 작업은 되돌릴 수 없습니다.", "Reset the local vault? This cannot be undone.")
    );

    if (!ok) return;
    await clearStoredSession();
    await wipeVault();
    window.location.reload();
  };

  const handleUnlock = async () => {
    if (inFlight.current || busy || !pin || retrySeconds > 0 || (retryAt && Date.now() < retryAt)) return;
    inFlight.current = true;
    setError("");
    setReason(null);
    setBusy(true);

    try {
      const result = await onUnlock(pin);

      if (!result.ok) {
        setError(result.reason === "locked"
          ? t("잠시 후 PIN을 다시 입력해 주세요.", "Wait before trying your PIN again.")
          : result.reason === "not_set"
            ? t("시작 키로 로그인한 후 PIN을 다시 설정해 주세요.", "Sign in with your start key, then reset your PIN.")
            : result.reason === "unavailable"
              ? t("이 기기에서는 PIN 잠금을 사용할 수 없습니다.", "PIN lock is unavailable on this device.")
              : t("PIN이 올바르지 않습니다. 다시 입력해 주세요.", "Incorrect PIN. Please try again."));
        setReason(result.reason ?? null);

        if (result.retryAfterMs) {
          setRetryAt(Date.now() + result.retryAfterMs);
        }
      } else {
        setRetryAt(null);
      }
    } catch (unlockError) {
      console.error("PIN unlock failed", unlockError);
      setError(t("PIN 잠금 해제에 실패했습니다.", "Could not unlock with your PIN. Please try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthShell testId="unlock-screen">
      <div className="mx-auto max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-nkc-selected text-2xl">
          <LockIcon className="h-7 w-7 text-nkc-accent" />
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t("다시 오신 것을 환영합니다", "Welcome back")}</h1>
        <p className="mt-2 text-sm leading-6 text-nkc-muted">
          {t("이 기기의 NKC 금고를 열려면 PIN을 입력하세요.", "Enter your PIN to unlock NKC on this device.")}</p>

        <label className="mt-7 block text-left text-sm font-medium">
          PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="\\d*"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void handleUnlock();
            }}
            className="nkc-auth-input mt-2 text-center text-lg tracking-[0.35em]"
            placeholder={t("4-8자리", "4-8 digits")}
            autoFocus
            data-testid="unlock-pin-input"
          />
        </label>

        {retrySeconds ? (
          <div className="mt-2 text-left text-xs text-nkc-muted">
            {t("다시 시도 가능:", "Try again in:")} {retrySeconds}s
          </div>
        ) : null}
        {error ? <div role="alert" className="mt-2 text-left text-xs nkc-error">{error}</div> : null}

        <button
          onClick={handleUnlock}
          className="mt-6 w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || retrySeconds > 0 || !pin}
          data-testid="unlock-submit-button"
        >
          {busy ? t("로그인 중...", "Signing in...") : t("로그인", "Sign in")}
        </button>
        {reason === "not_set" && onUseStartKey ? (
          <button
            onClick={() => void onUseStartKey()}
            className="mt-3 w-full rounded-xl px-4 py-2.5 text-xs font-medium text-nkc-accent hover:bg-nkc-hover"
          >
            {t("시작 키로 재설정", "Reset with start key")}</button>
        ) : null}
        <button
          onClick={handleReset}
          className="mt-1 w-full rounded-xl px-4 py-2.5 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
        >
          {t("로컬 금고 초기화", "Reset local vault")}</button>
      </div>
    </AuthShell>
  );
}
