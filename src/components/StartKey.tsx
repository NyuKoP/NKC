import { useAppStore } from "../app/store";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Download, Eye, EyeOff } from "lucide-react";
import {
  cleanupLegacyStartKey,
  copyStartKey,
  downloadStartKey,
  generateStartKey,
  getStartKeyConfirmed,
  getStoredStartKey,
  maskKey,
  setStartKeyConfirmed,
  storeStartKey,
} from "../security/startKey";
import AuthShell from "./auth/AuthShell";
import { KeyIcon } from "./icons/Icons";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { isStartKeyCompletionDisabled } from "./startKeyState";
import { getAccountOwnerGeneration } from "../accounts/accountOwnerLifecycle";
import { captureLocalOperationContext } from "../accounts/receiveContext";

type StartKeyProps = {
  onRotate: (key: string) => Promise<void>;
  onDone: () => void;
};

const cachedStartKeys = new Map<string, string>();

export default function StartKey({ onRotate, onDone }: StartKeyProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = useCallback((ko: string, en: string) => language === "ko" ? ko : en, [language]);
  const [startKey, setStartKey] = useState("");
  const [masked, setMasked] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    const loadKey = async () => {
      setError("");
      setBusy(true);

      try {
        const accountId = getActiveAccountId();
        await cleanupLegacyStartKey();
        const isConfirmed = await getStartKeyConfirmed();

        if (!active) return;
        const cachedStartKey = cachedStartKeys.get(accountId) || (isConfirmed ? await getStoredStartKey() : null);

        if (!active) return;
        setConfirmed(isConfirmed && Boolean(cachedStartKey));
        setAlreadyConfirmed(isConfirmed && Boolean(cachedStartKey));

        if (cachedStartKey) {
          setStartKey(cachedStartKey);
          setMasked(true);

          return;
        }

        const key = await generateStartKey();

        if (!active) return;
        cachedStartKeys.set(accountId, key);
        setStartKey(key);
        setMasked(true);
      } catch (loadError) {
        console.error("Failed to load start key", loadError);
        setError(t("시작 키를 불러오지 못했습니다.", "Could not load your start key. Please try again."));
      } finally {
        if (active) setBusy(false);
      }
    };

    void loadKey();

    return () => {
      active = false;
    };
  }, [t]);

  const maskedValue = useMemo(() => maskKey(startKey, masked), [masked, startKey]);

  const handleCopy = async () => {
    setError("");

    try {
      await copyStartKey(startKey);
    } catch (copyError) {
      console.error("Failed to copy start key", copyError);
      setError(t("시작 키 복사에 실패했습니다.", "Could not copy your start key."));
    }
  };

  return (
    <AuthShell testId="start-key-screen">
        <div className="text-center">
          <div className="mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-nkc-accent">
            {t("계정 설정 · 2/2", "Account setup · 2/2")}</div>
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-nkc-selected text-2xl">
            <KeyIcon className="h-7 w-7 text-nkc-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">{t("시작 키 저장", "Save your start key")}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-nkc-muted">
            {t("이 키는 NKC 계정에 다시 로그인할 수 있는 유일한 복구 수단입니다.", "This key is your only way to sign in to your NKC account again.")}</p>
        </div>

        <div className="mt-5 flex gap-2 rounded-xl border border-nkc-warningBorder bg-nkc-warningBg p-3 text-xs leading-5 text-nkc-text">
          <AlertTriangle className="mt-0.5 shrink-0 text-nkc-warning" size={16} />
          {t("NKC도 이 키를 복구해 드릴 수 없습니다. 다른 사람과 공유하거나 채팅으로 보내지 마세요.", "NKC cannot recover this key for you. Do not share it or send it in a chat.")}</div>

        <div className="mt-7 rounded-xl border border-nkc-border bg-nkc-panelMuted p-4">
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-nkc-border bg-nkc-bg px-4 py-3">
            <input
              value={maskedValue}
              readOnly
              autoComplete="off"
              aria-label={t("시작 키", "Start key")}
              className="w-full bg-transparent font-mono text-sm font-semibold leading-6 text-nkc-text focus:outline-none"
              placeholder={t("시작 키를 생성하세요", "Generate a start key")}
            />
            <button
              type="button"
              onClick={() => setMasked((value) => !value)}
              aria-label={masked ? t("시작 키 보기", "Show start key") : t("시작 키 숨기기", "Hide start key")}
              className="inline-flex w-fit items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-nkc-text hover:bg-nkc-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nkc-accent"
              disabled={!startKey || busy}
            >
              {masked ? <Eye size={14} /> : <EyeOff size={14} />}
              {masked ? t("시작 키 보기", "Show start key") : t("시작 키 숨기기", "Hide start key")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-lg border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!startKey || busy}
            >
              <Copy size={14} />
              {t("복사", "Copy")}</button>
            <button
              type="button"
              onClick={() => downloadStartKey(startKey)}
              className="flex items-center gap-2 rounded-lg border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!startKey || busy}
            >
              <Download size={14} />
              {t("파일로 저장", "Save to file")}</button>
          </div>
        </div>

        <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-nkc-border px-3 py-3 text-xs leading-5 text-nkc-muted">
          <input
            type="checkbox"
            data-testid="start-key-confirm-checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
              setError("");
            }}
            disabled={busy}
          />
          {t("시작 키를 안전한 곳에 저장했음을 확인했습니다.", "I have saved my start key in a safe place.")}</label>

        {error ? <div className="mt-2 text-xs nkc-error">{error}</div> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            data-testid="start-key-done-button"
            onClick={async () => {
              if (busy || !confirmed || !startKey) return;
              setBusy(true);
              setError("");
              const accountId = getActiveAccountId();

              try {
                if (!alreadyConfirmed) {
                  await onRotate(startKey);
                  setAlreadyConfirmed(true);
                }

                if (accountId !== getActiveAccountId()) throw new Error("OWNER_SESSION_CHANGED");
                const context = await captureLocalOperationContext();
                if (accountId !== getActiveAccountId()) throw new Error("OWNER_SESSION_CHANGED");
                const generation = getAccountOwnerGeneration();
                if (!await storeStartKey(startKey, context?.owner.session)) throw new Error("START_KEY_STORAGE_FAILED");
                context?.vault.assertLocal();
                await setStartKeyConfirmed(true, context?.vault);
                const flush = window.nkc?.flushAccountStorage;
                if (flush) {
                  if (!context) throw new Error("OWNER_REQUIRED");
                  await flush(context.owner.session);
                }
                if (accountId !== getActiveAccountId() || generation !== getAccountOwnerGeneration()) throw new Error("OWNER_SESSION_CHANGED");
                setMasked(true);
                onDone();
              } catch (confirmError) {
                console.error("Failed to confirm start key", confirmError);
                setError(t("시작 키 확인에 실패했습니다.", "Could not confirm your start key. Please try again."));
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-xl bg-nkc-accent px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isStartKeyCompletionDisabled({
              busy,
              alreadyConfirmed,
              startKey,
              confirmed,
            })}
          >
            {t("완료", "Done")}</button>
        </div>
    </AuthShell>
  );
}
