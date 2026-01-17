import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, RefreshCcw } from "lucide-react";
import {
  clearRecoveryConfirmed,
  copyRecoveryKey,
  generateRecoveryKey,
  getRecoveryConfirmed,
  getSavedRecoveryKey,
  maskKey,
  saveRecoveryKey,
  setRecoveryConfirmed,
} from "../security/recoveryKey";

type RecoveryProps = {
  onGenerate: (key: string) => Promise<void>;
  onDone: () => void;
};

export default function Recovery({ onGenerate, onDone }: RecoveryProps) {
  const [recoveryKey, setRecoveryKey] = useState("");
  const [masked, setMasked] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRecoveryConfirmed().then(setConfirmed).catch(() => setConfirmed(false));
  }, []);

  useEffect(() => {
    getSavedRecoveryKey()
      .then((key) => {
        if (key) {
          setRecoveryKey(key);
          setMasked(true);
        }
      })
      .catch((loadError) =>
        console.error("Failed to load saved recovery key", loadError)
      );
  }, []);

  const maskedValue = useMemo(() => maskKey(recoveryKey, masked), [masked, recoveryKey]);

  const handleGenerate = async () => {
    setError("");
    setBusy(true);
    try {
      const key = generateRecoveryKey();
      await onGenerate(key);
      setRecoveryKey(key);
      setMasked(true);
      setConfirmed(false);
      await clearRecoveryConfirmed();
    } catch (generateError) {
      console.error("Failed to generate recovery key", generateError);
      setError("복구키 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    setError("");
    try {
      await copyRecoveryKey(recoveryKey);
    } catch (copyError) {
      console.error("Failed to copy recovery key", copyError);
      setError("복구키 복사에 실패했습니다.");
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-nkc-bg px-6 py-10">
      <div className="w-full max-w-2xl rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">복구키</h1>
            <p className="mt-2 text-sm text-nkc-muted">
              복구키는 동기화/복구 전용이며 잠금 해제에는 사용할 수 없습니다.
            </p>
          </div>
          <span className="rounded-full bg-nkc-panelMuted px-3 py-1 text-xs font-semibold text-nkc-accent">
            NKC
          </span>
        </div>

        <div className="mt-6 rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4">
          <div className="flex flex-col gap-2 rounded-nkc border border-dashed border-nkc-border bg-nkc-panel px-3 py-2">
            <input
              value={maskedValue}
              readOnly
              autoComplete="off"
              aria-label="복구키"
              className="w-full bg-transparent text-sm font-semibold text-nkc-text focus:outline-none"
              placeholder="복구키를 생성하세요"
            />
            <button
              type="button"
              onClick={() => setMasked((value) => !value)}
              aria-label={masked ? "복구키 보기" : "복구키 숨기기"}
              className="inline-flex w-fit items-center gap-1 rounded-nkc border border-nkc-border px-3 py-1 text-xs font-medium text-nkc-text hover:bg-nkc-panelMuted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nkc-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nkc-panel"
              disabled={!recoveryKey}
            >
              {masked ? <Eye size={14} /> : <EyeOff size={14} />}
              {masked ? "복구키 보기" : "복구키 숨기기"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!recoveryKey}
            >
              <Copy size={14} />
              복사
            </button>
            <button
              onClick={handleGenerate}
              className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
            >
              <RefreshCcw size={14} />
              새 키 생성
            </button>
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-xs text-nkc-muted">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={async (event) => {
              const next = event.target.checked;
              setConfirmed(next);
              await setRecoveryConfirmed(next);
              if (next && recoveryKey) {
                await saveRecoveryKey(recoveryKey);
              }
            }}
          />
          저장했음
        </label>

        {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onDone}
            className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!recoveryKey || !confirmed}
          >
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
