import { useEffect, useState } from "react";
import { Upload } from "lucide-react";

type OnboardingProps = {
  onCreate: (displayName: string) => Promise<void>;
  onImport: (recoveryKey: string, displayName: string) => Promise<void>;
  defaultTab?: "create" | "import";
  errorMessage?: string;
};

export default function Onboarding({
  onCreate,
  onImport,
  defaultTab = "create",
  errorMessage,
}: OnboardingProps) {
  const [tab, setTab] = useState<"create" | "import">(defaultTab);
  const [displayName, setDisplayName] = useState("");
  const [importKey, setImportKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"create" | "import" | null>(null);
  const [localError, setLocalError] = useState("");

  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const logClick = (mode: "create" | "import", disabled: boolean) => {
    if (!isDev) return;
    console.log("Onboarding button clicked", { mode, disabled });
  };

  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  const handleUpload = async (file: File) => {
    const text = await file.text();
    setImportKey(text.trim());
  };

  return (
    <div className="flex h-full items-center justify-center bg-nkc-bg px-6 py-10">
      <div className="w-full max-w-2xl rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">NKC 시작하기</h1>
            <p className="mt-2 text-sm text-nkc-muted">
              복구키는 복구 화면에서만 생성됩니다. 설정 후 바로 저장하세요.
            </p>
          </div>
          <span className="rounded-full bg-nkc-panelMuted px-3 py-1 text-xs font-semibold text-nkc-accent">
            NKC
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-sm">
          <button
            className={`rounded-nkc px-4 py-2 font-semibold ${
              tab === "create" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            onClick={() => setTab("create")}
          >
            새 계정
          </button>
          <button
            className={`rounded-nkc px-4 py-2 font-semibold ${
              tab === "import" ? "bg-nkc-panel text-nkc-text" : "text-nkc-muted"
            }`}
            onClick={() => setTab("import")}
          >
            복구키 가져오기
          </button>
        </div>

        {tab === "create" ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4 text-xs text-nkc-muted">
              복구키는 설정 완료 후 복구키 화면에서 생성합니다.
            </div>

            <label className="text-sm">
              표시 이름
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC 사용자"
                data-testid="onboarding-display-name"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-nkc-muted">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setLocalError("");
                }}
                data-testid="onboarding-confirm-checkbox"
              />
              복구키를 별도로 저장해야 함을 확인했습니다.
            </label>

            <button
              onClick={async () => {
                const disabled = !confirmed || busy === "create";
                logClick("create", disabled);
                if (!confirmed) {
                  setLocalError("체크박스를 확인해주세요.");
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
              className="w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!confirmed || busy === "create"}
              data-testid="onboarding-create-button"
            >
              {busy === "create" ? "처리 중..." : "계속하기"}
            </button>
            {!confirmed ? (
              <div className="text-xs text-nkc-muted">체크박스를 확인해주세요.</div>
            ) : null}
            {localError ? <div className="text-xs text-red-300">{localError}</div> : null}
            {errorMessage ? (
              <div className="text-xs text-red-300">{errorMessage}</div>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <label className="text-sm">
              복구키 입력
              <textarea
                value={importKey}
                onChange={(event) => {
                  setImportKey(event.target.value);
                  setLocalError("");
                }}
                className="mt-2 h-24 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC-..."
              />
            </label>

            <label className="flex cursor-pointer items-center gap-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
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

            <label className="text-sm">
              표시 이름
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC 사용자"
              />
            </label>

            <button
              onClick={async () => {
                const disabled = !importKey.trim() || busy === "import";
                logClick("import", disabled);
                if (!importKey.trim()) {
                  setLocalError("복구키를 입력해주세요.");
                  return;
                }
                setLocalError("");
                setBusy("import");
                try {
                  await onImport(importKey.trim(), displayName.trim() || "NKC 사용자");
                } catch (error) {
                  console.error("Onboarding import failed", error);
                  setLocalError("복구키로 잠금 해제에 실패했습니다.");
                } finally {
                  setBusy(null);
                }
              }}
              className="w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy === "import"}
            >
              {busy === "import" ? "처리 중..." : "복구키로 잠금 해제"}
            </button>
            {!importKey.trim() ? (
              <div className="text-xs text-nkc-muted">복구키를 입력해주세요.</div>
            ) : null}
            {localError ? <div className="text-xs text-red-300">{localError}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}
