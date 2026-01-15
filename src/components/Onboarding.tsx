import { useEffect, useMemo, useState } from "react";
import { Download, Eye, EyeOff, KeyRound, Upload } from "lucide-react";
import { generateRecoveryKey } from "../crypto/vault";
import { useAppStore } from "../app/store";

type OnboardingProps = {
  onCreate: (recoveryKey: string, displayName: string) => Promise<void>;
  onImport: (recoveryKey: string, displayName: string) => Promise<void>;
};

export default function Onboarding({ onCreate, onImport }: OnboardingProps) {
  const [tab, setTab] = useState<"create" | "import">("create");
  const recoveryKey = useAppStore((state) => state.ui.onboardingRecoveryKey);
  const setRecoveryKey = useAppStore((state) => state.setOnboardingRecoveryKey);
  const setMode = useAppStore((state) => state.setMode);
  const setSession = useAppStore((state) => state.setSession);
  const setData = useAppStore((state) => state.setData);
  const [displayName, setDisplayName] = useState("");
  const [importKey, setImportKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [masked, setMasked] = useState(true);

  useEffect(() => {
    if (tab === "create" && !recoveryKey) {
      generateRecoveryKey().then(setRecoveryKey);
    }
  }, [recoveryKey, setRecoveryKey, tab]);

  useEffect(() => {
    setMasked(true);
  }, [tab]);

  const maskedValue = useMemo(() => {
    if (!recoveryKey) return "";
    return "●".repeat(recoveryKey.length);
  }, [recoveryKey]);

  const handleCopy = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
  };

  const handleDownload = () => {
    if (!recoveryKey) return;
    const blob = new Blob([recoveryKey], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nkc-recovery-key.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = async (file: File) => {
    const text = await file.text();
    setImportKey(text.trim());
  };

  const handleTestEnter = () => {
    setSession({ unlocked: false, vkInMemory: false });
    setData({ user: null, friends: [], convs: [], messagesByConv: {} });
    setMode("app");
  };

  return (
    <div className="flex h-full items-center justify-center bg-nkc-bg px-6 py-10">
      <div className="w-full max-w-2xl rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">NKC 시작하기</h1>
            <p className="mt-2 text-sm text-nkc-muted">
              복구키로만 로컬 금고를 열 수 있습니다. 절대 잃지 마세요.
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
            <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-nkc-text">내 복구키</h3>
                  <p className="mt-1 text-xs text-nkc-muted">
                    이 키는 저장소 접근을 복구하는 유일한 방법입니다.
                  </p>
                </div>
                <KeyRound className="text-nkc-accent" size={18} />
              </div>
              <div className="mt-3 flex flex-col gap-2 rounded-nkc border border-dashed border-nkc-border bg-nkc-panel px-3 py-2">
                <input
                  value={masked ? maskedValue : recoveryKey}
                  readOnly
                  autoComplete="off"
                  aria-label="복구키"
                  className="w-full bg-transparent text-sm font-semibold text-nkc-text focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setMasked((value) => !value)}
                  aria-label={masked ? "복구키 보기" : "복구키 숨기기"}
                  className="inline-flex w-fit items-center gap-1 rounded-nkc border border-nkc-border px-3 py-1 text-xs font-medium text-nkc-text hover:bg-nkc-panelMuted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nkc-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nkc-panel"
                >
                  {masked ? <Eye size={14} /> : <EyeOff size={14} />}
                  {masked ? "복구키 보기" : "복구키 숨기기"}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={handleCopy}
                  className="rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!recoveryKey}
                >
                  복사
                </button>
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!recoveryKey}
                >
                  <Download size={14} />
                  txt 저장
                </button>
                <button
                  onClick={async () => {
                    setRecoveryKey(await generateRecoveryKey());
                    setMasked(true);
                  }}
                  className="rounded-nkc border border-nkc-border px-3 py-2 text-xs hover:bg-nkc-panel"
                >
                  새 키 생성
                </button>
              </div>
            </div>

            <label className="text-sm">
              표시 이름
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC 사용자"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-nkc-muted">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              복구키를 안전한 곳에 저장했습니다.
            </label>

            <button
              onClick={() => onCreate(recoveryKey, displayName.trim() || "NKC 사용자")}
              className="w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!confirmed || !recoveryKey}
            >
              이 키로 시작하기
            </button>
            <button
              onClick={handleTestEnter}
              className="w-full rounded-nkc border border-nkc-border px-4 py-2 text-xs text-nkc-muted hover:bg-nkc-panel"
            >
              테스트 채팅 바로가기
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <label className="text-sm">
              복구키 입력
              <textarea
                value={importKey}
                onChange={(event) => setImportKey(event.target.value)}
                className="mt-2 h-24 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="NKC-XXXX-XXXX-XXXX-XXXX"
              />
            </label>

            <label className="flex cursor-pointer items-center gap-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
              <Upload size={14} />
              텍스트 파일 가져오기
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
              onClick={() => onImport(importKey, displayName.trim() || "NKC 사용자")}
              className="w-full rounded-nkc bg-nkc-accent px-4 py-3 text-sm font-semibold text-nkc-bg"
            >
              복구키로 잠금 해제
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
