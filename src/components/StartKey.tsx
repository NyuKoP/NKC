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
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-2xl rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">시작 키(로그인 키)</h1>
            <p className="mt-2 text-sm text-nkc-muted">
              시작 키는 이 기기의 잠금 해제와 로컬 암호화에만 사용됩니다.
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
              aria-label="시작 키"
              className="w-full bg-transparent text-sm font-semibold text-nkc-text focus:outline-none"
              placeholder="시작 키를 생성하세요"
            />
            <button
              type="button"
              onClick={() => setMasked((value) => !value)}
              aria-label={masked ? "시작 키 보기" : "시작 키 숨기기"}
              className="inline-flex w-fit items-center gap-1 rounded-nkc border border-nkc-border px-3 py-1 text-xs font-medium text-nkc-text hover:bg-nkc-panelMuted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nkc-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nkc-panel"
              disabled={!startKey || busy}
            >
              {masked ? <Eye size={14} /> : <EyeOff size={14} />}
              {masked ? "시작 키 보기" : "시작 키 숨기기"}
            </button>
          </div>
          {alreadyConfirmed ? (
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!startKey || busy}
            >
              <Copy size={14} />
              복사
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
            className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
            disabled={alreadyConfirmed ? false : !startKey || !confirmed}
          >
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
