import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Eye, EyeOff, RefreshCw, ShieldCheck } from "lucide-react";
import {
  copyStartKey,
  generateStartKey,
  getStoredStartKey,
  maskKey,
  storeStartKey,
} from "../../../security/startKey";
import SettingsBackHeader from "../SettingsBackHeader";

type RecoveryKeySettingsProps = {
  t: (ko: string, en: string) => string;
  onBack: () => void;
  onRotate: (key: string) => Promise<void>;
};

export default function RecoveryKeySettings({
  t,
  onBack,
  onRotate,
}: RecoveryKeySettingsProps) {
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getStoredStartKey().then((value) => {
      if (!active) return;
      setStoredKey(value);
      setBusy(false);
    });

    return () => {
      active = false;
    };
  }, []);

  const visibleKey = candidate || storedKey || "";

  const displayedKey = useMemo(
    () => maskKey(visibleKey, !revealed),
    [revealed, visibleKey]
  );

  const beginRotation = async () => {
    setError("");
    setCandidate(await generateStartKey());
    setConfirmed(false);
    setRevealed(true);
  };

  const confirmRotation = async () => {
    if (!candidate || !confirmed || busy) return;
    setBusy(true);
    setError("");

    try {
      await onRotate(candidate);
      const persisted = await storeStartKey(candidate);
      setStoredKey(candidate);
      setCandidate("");
      setConfirmed(false);
      setRevealed(false);

      if (!persisted) {
        setError(t(
          "키는 변경됐지만 운영체제 보안 저장소에 보관하지 못했습니다. 지금 별도로 저장하세요.",
          "The key changed, but it could not be saved in the OS secure store. Save it separately now."
        ));
      }
    } catch (rotationError) {
      console.error("Failed to rotate recovery key", rotationError);
      setError(t("복구 키 변경에 실패했습니다.", "Failed to change the recovery key."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 grid gap-6" data-testid="recovery-key-settings">
      <SettingsBackHeader
        title={t("키 / 복구", "Keys / Recovery")}
        backLabel={t("뒤로", "Back")}
        onBack={onBack}
      />

      <section className="rounded-2xl border border-nkc-border bg-nkc-panel p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-nkc-selected p-2 text-nkc-accent">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h3 className="font-semibold text-nkc-text">
              {candidate
                ? t("새 복구 키 저장", "Save the new recovery key")
                : t("이 계정의 복구 키", "Recovery key for this account")}
            </h3>
            <p className="mt-1 text-sm leading-6 text-nkc-muted">
              {t(
                "복구 키는 계정별로 분리되며 이 기기에서는 운영체제 보안 저장소로 보호됩니다.",
                "Recovery keys are isolated per account and protected by the OS secure store on this device."
              )}
            </p>
          </div>
        </div>

        {visibleKey ? (
          <div className="mt-5 rounded-xl border border-nkc-border bg-nkc-bg p-4">
            <div className="break-all font-mono text-sm font-semibold leading-6 text-nkc-text">
              {displayedKey}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setRevealed((value) => !value)}
                className="inline-flex items-center gap-2 rounded-lg border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-hover"
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                {revealed ? t("숨기기", "Hide") : t("보기", "Reveal")}
              </button>
              <button
                type="button"
                onClick={() => void copyStartKey(visibleKey)}
                className="inline-flex items-center gap-2 rounded-lg border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-hover"
              >
                <Copy size={14} />
                {t("복사", "Copy")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-nkc-warningBorder bg-nkc-warningBg p-4 text-sm leading-6 text-nkc-text">
            {busy
              ? t("보안 저장소를 확인하는 중입니다…", "Checking the secure store…")
              : t(
                  "이 계정의 기존 키는 기기에 저장되어 있지 않습니다. 새 복구 키를 만들어 안전한 곳에 보관하세요.",
                  "The existing key is not stored on this device. Create a new recovery key and keep it somewhere safe."
                )}
          </div>
        )}

        {candidate ? (
          <div className="mt-4 grid gap-3">
            <div className="flex gap-2 rounded-xl border border-nkc-dangerBorder bg-nkc-dangerBg p-3 text-xs leading-5 text-nkc-text">
              <AlertTriangle className="mt-0.5 shrink-0 text-nkc-danger" size={16} />
              {t(
                "변경하면 이전 복구 키는 즉시 사용할 수 없습니다. 누구에게도 키를 공유하지 마세요.",
                "After changing it, the old recovery key stops working immediately. Never share this key."
              )}
            </div>
            <label className="flex items-start gap-2 text-xs leading-5 text-nkc-muted">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={busy}
              />
              {t("새 키를 별도의 안전한 곳에 저장했습니다.", "I saved the new key somewhere safe.")}
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCandidate("");
                  setConfirmed(false);
                  setRevealed(false);
                }}
                className="rounded-lg border border-nkc-border px-4 py-2 text-sm hover:bg-nkc-hover"
                disabled={busy}
              >
                {t("취소", "Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmRotation()}
                className="rounded-lg bg-nkc-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!confirmed || busy}
              >
                {busy ? t("변경 중…", "Changing…") : t("키 변경", "Change key")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void beginRotation()}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-nkc-border px-4 py-2 text-sm hover:bg-nkc-hover disabled:opacity-50"
            disabled={busy}
          >
            <RefreshCw size={15} />
            {t("새 복구 키 만들기", "Create a new recovery key")}
          </button>
        )}

        {error ? <p className="mt-3 text-xs text-nkc-danger">{error}</p> : null}
      </section>
    </div>
  );
}
