import { useCallback, useEffect, useState } from "react";
import SettingsBackHeader from "../SettingsBackHeader";

type AppUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "current" | "error" | "unsupported";
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  releaseNotes?: string;
  error?: string;
};

type AppUpdateBridge = {
  getStatus: () => Promise<AppUpdateStatus>;
  check: () => Promise<AppUpdateStatus>;
  download: () => Promise<AppUpdateStatus>;
  install: () => Promise<void>;
  onStatus: (cb: (status: AppUpdateStatus) => void) => () => void;
};

type Props = {
  t: (ko: string, en: string) => string;
  onBack: () => void;
};

const getBridge = () => (globalThis as typeof globalThis & { appUpdate?: AppUpdateBridge }).appUpdate;

export default function AppUpdateSettings({ t, onBack }: Props) {
  const [status, setStatus] = useState<AppUpdateStatus>({ state: "idle", currentVersion: "-" });
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) {
      setStatus({ state: "unsupported", currentVersion: "-", error: "bridge-unavailable" });
      return;
    }
    void bridge.getStatus().then(setStatus).catch((error: unknown) =>
      setStatus((current) => ({ ...current, state: "error", error: error instanceof Error ? error.message : String(error) }))
    );
    return bridge.onStatus(setStatus);
  }, []);

  const run = useCallback(async (action: "check" | "download" | "install") => {
    const bridge = getBridge();
    if (!bridge) return;
    setBusy(true);
    if (action === "check") setCheckResult(null);
    try {
      if (action === "install") await bridge.install();
      else {
        const nextStatus = await bridge[action]();
        setStatus(nextStatus);
        if (action === "check") {
          if (nextStatus.state === "current") {
            setCheckResult(t("최신 버전입니다.", "You are using the latest version."));
          } else if (nextStatus.state === "available") {
            setCheckResult(t("새로운 버전이 있습니다.", "A new version is available."));
          }
        }
      }
    } catch (error) {
      setStatus((current) => ({
        ...current,
        state: current.state === "unsupported" ? "unsupported" : "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const message = (() => {
    switch (status.state) {
      case "checking": return t("새 버전을 확인하고 있습니다.", "Checking for a new version.");
      case "available": return t(`새 버전 ${status.latestVersion ?? ""}을 사용할 수 있습니다.`, `Version ${status.latestVersion ?? ""} is available.`);
      case "downloading": return t(`업데이트 다운로드 중 ${Math.round(status.percent ?? 0)}%`, `Downloading update ${Math.round(status.percent ?? 0)}%`);
      case "downloaded": return t("업데이트 준비가 끝났습니다. 재시작하면 설치됩니다.", "The update is ready. Restart to install it.");
      case "current": return t("최신 버전을 사용 중입니다.", "You are using the latest version.");
      case "unsupported": return status.error === "packaged-app-required"
        ? t("개발 실행본에서는 앱 업데이트를 사용할 수 없습니다.", "App updates are unavailable in development builds.")
        : t("현재 설치 형식에서는 자동 업데이트를 사용할 수 없습니다.", "Automatic updates are unavailable for this install format.");
      case "error": return t(`업데이트 확인 실패: ${status.error ?? "unknown"}`, `Update failed: ${status.error ?? "unknown"}`);
      default: return t("업데이트를 확인할 수 있습니다.", "You can check for updates.");
    }
  })();

  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader title={t("앱 업데이트", "App updates")} backLabel={t("뒤로", "Back")} onBack={onBack} />
      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-nkc-text">NKC</div>
            <div className="mt-1 text-xs text-nkc-muted">{message}</div>
          </div>
          <span className="rounded-full border border-nkc-border px-3 py-1 text-xs text-nkc-text">
            v{status.currentVersion}
          </span>
        </div>
        {status.state === "downloading" && (
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-nkc-panel">
            <div className="h-full bg-nkc-accent transition-[width]" style={{ width: `${status.percent ?? 0}%` }} />
          </div>
        )}
        {checkResult && (
          <div role="status" className="mt-4 rounded-nkc border border-nkc-accent/50 bg-nkc-accent/10 px-4 py-3 text-sm font-medium text-nkc-text">
            {checkResult}
          </div>
        )}
        <div className="mt-5 rounded-nkc border border-nkc-border bg-nkc-panel p-4">
          <div className="text-xs font-semibold text-nkc-text">
            {t("업데이트 릴리스 노트", "Update release notes")}
          </div>
          <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-nkc-muted">
            {status.releaseNotes || t("제공된 릴리스 노트가 없습니다.", "No release notes were provided.")}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {status.state === "available" ? (
            <button type="button" disabled={busy} onClick={() => void run("download")} className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
              {t("다운로드", "Download")}
            </button>
          ) : status.state === "downloaded" ? (
            <button type="button" disabled={busy} onClick={() => void run("install")} className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
              {t("재시작 및 설치", "Restart and install")}
            </button>
          ) : (
            <button type="button" disabled={busy || status.state === "checking" || status.state === "downloading" || status.state === "unsupported"} onClick={() => void run("check")} className="rounded-nkc border border-nkc-border px-4 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:opacity-50">
              {busy || status.state === "checking" ? t("확인 중...", "Checking...") : t("업데이트 확인", "Check for updates")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
