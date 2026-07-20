import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import {
  cleanupLegacyStartKey,
  copyStartKey,
  generateStartKey,
  getStartKeyConfirmed,
  maskKey,
  setStartKeyConfirmed,
} from "../security/startKey";
import AuthShell from "./auth/AuthShell";
import { KeyIcon } from "./icons/Icons";

type StartKeyProps = {
  onRotate: (key: string) => Promise<void>;
  onDone: () => void;
};

let cachedStartKey: string | null = null;

export default function StartKey({ onRotate, onDone }: StartKeyProps) {
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
        await cleanupLegacyStartKey();
        const isConfirmed = await getStartKeyConfirmed();
        if (!active) return;
        setConfirmed(isConfirmed);
        if (isConfirmed) {
          setAlreadyConfirmed(true);
        }
        if (cachedStartKey) {
          setStartKey(cachedStartKey);
          setMasked(true);
          return;
        }
        const key = await generateStartKey();
        if (!active) return;
        cachedStartKey = key;
        setStartKey(key);
        setMasked(true);
      } catch (loadError) {
        console.error("Failed to load start key", loadError);
        setError("시작 키를 불러오지 못했습니다.");
      } finally {
        if (active) setBusy(false);
      }
    };
    void loadKey();
    return () => {
      active = false;
    };
  }, [onRotate]);

  const maskedValue = useMemo(() => maskKey(startKey, masked), [masked, startKey]);

  const handleCopy = async () => {
    setError("");
    try {
      await copyStartKey(startKey);
    } catch (copyError) {
      console.error("Failed to copy start key", copyError);
      setError("시작 키 복사에 실패했습니다.");
    }
  };

  return (
    <AuthShell testId="start-key-screen">
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-nkc-selected text-2xl">
            <KeyIcon className="h-7 w-7 text-nkc-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">시작 키 저장</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-nkc-muted">
            이 키는 NKC 계정에 다시 로그인할 수 있는 유일한 복구 수단입니다.
          </p>
        </div>

        <div className="mt-7 rounded-xl border border-nkc-border bg-nkc-panelMuted p-4">
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-nkc-border bg-nkc-bg px-4 py-3">
            <input
              value={maskedValue}
              readOnly
              autoComplete="off"
              aria-label="시작 키"
              className="w-full bg-transparent font-mono text-sm font-semibold leading-6 text-nkc-text focus:outline-none"
              placeholder="시작 키를 생성하세요"
            />
            <button
              type="button"
              onClick={() => setMasked((value) => !value)}
              aria-label={masked ? "시작 키 보기" : "시작 키 숨기기"}
              className="inline-flex w-fit items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-nkc-text hover:bg-nkc-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nkc-accent"
              disabled={!startKey || busy}
            >
              {masked ? <Eye size={14} /> : <EyeOff size={14} />}
              {masked ? "시작 키 보기" : "시작 키 숨기기"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-lg border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!startKey || busy}
            >
              <Copy size={14} />
              복사
            </button>
          </div>
        </div>

        <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-nkc-border px-3 py-3 text-xs leading-5 text-nkc-muted">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={async (event) => {
              const next = event.target.checked;
              setConfirmed(next);
              if (!next) {
                await setStartKeyConfirmed(false);
                return;
              }
              if (!startKey) return;
              setBusy(true);
              setError("");
              try {
                await onRotate(startKey);
                await setStartKeyConfirmed(true);
                setAlreadyConfirmed(true);
                setMasked(true);
              } catch (confirmError) {
                console.error("Failed to confirm start key", confirmError);
                setError("시작 키 확인에 실패했습니다.");
                setConfirmed(false);
              } finally {
                setBusy(false);
              }
            }}
            disabled={alreadyConfirmed}
          />
          시작 키를 안전한 곳에 저장했음을 확인했습니다.
        </label>

        {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onDone}
            className="rounded-xl bg-nkc-accent px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={alreadyConfirmed ? false : !startKey || !confirmed}
          >
            완료
          </button>
        </div>
    </AuthShell>
  );
}
