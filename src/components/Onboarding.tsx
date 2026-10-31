import { useAppStore } from "../app/store";
import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import AuthShell from "./auth/AuthShell";
import { LockIcon } from "./icons/Icons";
import { MAX_LOCAL_ACCOUNTS } from "../accounts/accountRegistry";

type OnboardingProps = {
  onCreate: (displayName: string) => Promise<void>;
  onUnlockWithStartKey: (startKey: string) => Promise<void>;
  defaultTab?: "create" | "startKey";
  errorMessage?: string;
};

export default function Onboarding({
  onCreate,
  onUnlockWithStartKey,
  defaultTab = "create",
  errorMessage,
}: OnboardingProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const [tab, setTab] = useState<"create" | "startKey">(defaultTab);
  const [displayName, setDisplayName] = useState("");
  const [startKey, setStartKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"create" | "startKey" | null>(null);
  const [localError, setLocalError] = useState("");

  const isDev = Boolean(import.meta.env?.DEV);

  const logClick = (mode: "create" | "startKey", disabled: boolean) => {
    if (!isDev) return;
    console.log("Onboarding button clicked", { mode, disabled });
  };

  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const handleUpload = async (file: File) => {
    const text = await file.text();
    setStartKey(text.trim());
  };

  return (
    <AuthShell testId="onboarding-screen">
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-nkc-selected text-2xl">
            <LockIcon className="h-7 w-7 text-nkc-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">
            {tab === "create" ? t("NKC 계정 만들기", "Create an NKC account") : t("NKC에 로그인", "Sign in to NKC")}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-nkc-muted">
            {tab === "create"
              ? t("서버 계정 없이 이 기기에 암호화된 개인 프로필을 만듭니다.", "Create an encrypted personal profile on this device without a server account.")
              : t("보관해 둔 시작 키로 기존 로컬 금고를 잠금 해제합니다.", "Unlock your existing local vault with your saved start key.")}
          </p>
        </div>

        <div className="mt-7 grid grid-cols-2 gap-1 rounded-xl bg-nkc-panelMuted p-1 text-sm">
          <button
            className={`rounded-lg px-4 py-2.5 font-semibold transition-colors ${
              tab === "create" ? "bg-nkc-surface text-nkc-text" : "text-nkc-muted hover:text-nkc-text"
            }`}
            onClick={() => setTab("create")}
            data-testid="onboarding-create-tab"
          >
            {t("새 계정", "New account")}</button>
          <button
            className={`rounded-lg px-4 py-2.5 font-semibold transition-colors ${
              tab === "startKey" ? "bg-nkc-surface text-nkc-text" : "text-nkc-muted hover:text-nkc-text"
            }`}
            onClick={() => setTab("startKey")}
            data-testid="onboarding-start-key-tab"
          >
            {t("시작 키 로그인", "Sign in with start key")}</button>
        </div>

        {tab === "create" ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-nkc-border bg-nkc-panelMuted p-4 text-xs leading-5 text-nkc-muted">
              {t(`NKC는 중앙 서버 없이 작동합니다. 이 기기에는 신규 로컬 계정을 최대 ${MAX_LOCAL_ACCOUNTS}개까지 만들 수 있습니다. 기기를 잃어버리면 시작 키 없이는 계정을 복구할 수 없으므로, 시작 키를 안전하게 보관하세요.`, `NKC works without a central server. You can create up to ${MAX_LOCAL_ACCOUNTS} local accounts on this device. Keep your start key safe: if you lose your device, you cannot recover your account without it.`)}
            </div>

            <label className="text-sm">
              {t("표시 이름", "Display name")}<input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="nkc-auth-input mt-2"
                placeholder={t("NKC 사용자", "NKC user")}
                data-testid="onboarding-display-name"
              />
            </label>

            <label className="flex items-start gap-2.5 rounded-xl border border-nkc-border px-3 py-3 text-xs leading-5 text-nkc-muted">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setLocalError("");
                }}
                data-testid="onboarding-confirm-checkbox"
              />
              {t("시작 키를 별도로 보관해야 계정을 다시 열 수 있다는 내용을 확인했습니다.", "I understand that I must keep my start key separately to reopen my account.")}</label>

            <button
              onClick={async () => {
                const disabled = !confirmed || busy === "create";
                logClick("create", disabled);

                if (!confirmed) {
                  setLocalError(t("확인 체크박스를 선택해 주세요.", "Please select the confirmation checkbox."));

                  return;
                }

                setLocalError("");
                setBusy("create");

                try {
                  await onCreate(displayName.trim() || t("NKC 사용자", "NKC user"));
                } catch (error) {
                  console.error("Onboarding create failed", error);
                  setLocalError(t("계정 생성에 실패했습니다.", "Could not create your account. Please try again."));
                } finally {
                  setBusy(null);
                }
              }}
              className="w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!confirmed || busy === "create"}
              data-testid="onboarding-create-button"
            >
              {busy === "create" ? t("계정 만드는 중...", "Creating account...") : t("계정 만들기", "Create account")}
            </button>
            {!confirmed ? (
              <div className="text-xs text-nkc-muted">{t("확인 체크박스를 선택해 주세요.", "Please select the confirmation checkbox.")}</div>
            ) : null}
            {localError ? <div className="text-xs nkc-error">{localError}</div> : null}
            {errorMessage ? (
              <div className="text-xs nkc-error">{errorMessage}</div>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <label className="text-sm">
              {t("시작 키 입력", "Enter start key")}<textarea
                value={startKey}
                onChange={(event) => {
                  setStartKey(event.target.value);
                  setLocalError("");
                }}
                className="nkc-auth-input mt-2 h-28 resize-none font-mono text-xs"
                placeholder="NKC-..."
                data-testid="onboarding-start-key-input"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-nkc-border px-3 py-3 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text">
              <Upload size={14} />
              {t("txt 파일 가져오기", "Import txt file")}<input
                type="file"
                accept=".txt"
                className="hidden"
                onChange={(event) =>
                  event.target.files?.[0] && handleUpload(event.target.files[0])
                }
              />
            </label>

            <button
              onClick={async () => {
                const disabled = !startKey.trim() || busy === "startKey";
                logClick("startKey", disabled);

                if (!startKey.trim()) {
                  setLocalError(t("시작 키를 입력해 주세요.", "Please enter your start key."));

                  return;
                }

                setLocalError("");
                setBusy("startKey");

                try {
                  await onUnlockWithStartKey(startKey.trim());
                } catch (error) {
                  console.error("Onboarding start key unlock failed", error);
                  setLocalError(t("시작 키로 잠금 해제에 실패했습니다.", "Could not unlock with this start key. Check the key and try again."));
                } finally {
                  setBusy(null);
                }
              }}
              className="w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy === "startKey"}
              data-testid="onboarding-start-key-button"
            >
              {busy === "startKey" ? t("로그인 중...", "Signing in...") : t("로그인", "Sign in")}
            </button>
            {!startKey.trim() ? (
              <div className="text-xs text-nkc-muted">{t("시작 키를 입력해 주세요.", "Please enter your start key.")}</div>
            ) : null}
            {localError ? <div className="text-xs nkc-error">{localError}</div> : null}
            {errorMessage ? <div className="text-xs nkc-error">{errorMessage}</div> : null}
          </div>
        )}
    </AuthShell>
  );
}
