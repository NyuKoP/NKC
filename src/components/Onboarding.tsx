import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import AuthShell from "./auth/AuthShell";
import { LockIcon } from "./icons/Icons";

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
  const [tab, setTab] = useState<"create" | "startKey">(defaultTab);
  const [displayName, setDisplayName] = useState("");
  const [startKey, setStartKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"create" | "startKey" | null>(null);
  const [localError, setLocalError] = useState("");

  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
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
            {tab === "create" ? "NKC 계정 만들기" : "NKC에 로그인"}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-nkc-muted">
            {tab === "create"
              ? "서버 계정 없이 이 기기에 암호화된 개인 프로필을 만듭니다."
              : "보관해 둔 시작 키로 기존 로컬 금고를 잠금 해제합니다."}
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
            새 계정
          </button>
          <button
            className={`rounded-lg px-4 py-2.5 font-semibold transition-colors ${
              tab === "startKey" ? "bg-nkc-surface text-nkc-text" : "text-nkc-muted hover:text-nkc-text"
            }`}
            onClick={() => setTab("startKey")}
            data-testid="onboarding-start-key-tab"
          >
            시작 키 로그인
          </button>
        </div>

        {tab === "create" ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-nkc-border bg-nkc-panelMuted p-4 text-xs leading-5 text-nkc-muted">
              NKC는 중앙 서버 없이 작동합니다. 기기를 잃어버리면 시작 키 없이는 계정을 복구할 수 없으므로, 시작 키를 안전하게 보관하세요.
            </div>

            <label className="text-sm">
              표시 이름
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="nkc-auth-input mt-2"
                placeholder="NKC 사용자"
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
              시작 키를 별도로 보관해야 계정을 다시 열 수 있다는 내용을 확인했습니다.
            </label>

            <button
              onClick={async () => {
                const disabled = !confirmed || busy === "create";
                logClick("create", disabled);
                if (!confirmed) {
                  setLocalError("확인 체크박스를 선택해 주세요.");
                  return;
                }
                setLocalError("");
                setBusy("create");
                try {
                  await onCreate(displayName.trim() || "NKC 사용자");
                } catch (error) {
                  console.error("Onboarding create failed", error);
                  setLocalError("계정 생성에 실패했습니다.");
                } finally {
                  setBusy(null);
                }
              }}
              className="w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!confirmed || busy === "create"}
              data-testid="onboarding-create-button"
            >
              {busy === "create" ? "계정 만드는 중..." : "계정 만들기"}
            </button>
            {!confirmed ? (
              <div className="text-xs text-nkc-muted">확인 체크박스를 선택해 주세요.</div>
            ) : null}
            {localError ? <div className="text-xs text-red-300">{localError}</div> : null}
            {errorMessage ? (
              <div className="text-xs text-red-300">{errorMessage}</div>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <label className="text-sm">
              시작 키 입력
              <textarea
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
              txt 파일 가져오기
              <input
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
                  setLocalError("시작 키를 입력해 주세요.");
                  return;
                }
                setLocalError("");
                setBusy("startKey");
                try {
                  await onUnlockWithStartKey(startKey.trim());
                } catch (error) {
                  console.error("Onboarding start key unlock failed", error);
                  setLocalError("시작 키로 잠금 해제에 실패했습니다.");
                } finally {
                  setBusy(null);
                }
              }}
              className="w-full rounded-xl bg-nkc-accent px-4 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy === "startKey"}
              data-testid="onboarding-start-key-button"
            >
              {busy === "startKey" ? "로그인 중..." : "로그인"}
            </button>
            {!startKey.trim() ? (
              <div className="text-xs text-nkc-muted">시작 키를 입력해 주세요.</div>
            ) : null}
            {localError ? <div className="text-xs text-red-300">{localError}</div> : null}
            {errorMessage ? <div className="text-xs text-red-300">{errorMessage}</div> : null}
          </div>
        )}
    </AuthShell>
  );
}
