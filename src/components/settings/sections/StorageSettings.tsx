import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type StorageSettingsProps = {
  t: Translate;
  onBack: () => void;
  vaultUsageBytes: number;
  vaultUsageMaxBytes: number;
  formatBytes: (value: number) => string;
  chatWipeBusy: boolean;
  mediaWipeBusy: boolean;
  onRequestWipeChat: () => void;
  onRequestWipeMedia: () => void;
};

export default function StorageSettings({
  t,
  onBack,
  vaultUsageBytes,
  vaultUsageMaxBytes,
  formatBytes,
  chatWipeBusy,
  mediaWipeBusy,
  onRequestWipeChat,
  onRequestWipeMedia,
}: StorageSettingsProps) {
  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader
        title={t("저장소 관리", "Storage management")}
        backLabel={t("뒤로", "Back")}
        onBack={onBack}
      />
      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">{t("저장소 관리", "Storage management")}</div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "삭제 후에는 복구할 수 없습니다. 삭제 시 데이터를 암호화로 덮어씌운 뒤 제거합니다.",
            "Deletion cannot be undone. Data is overwritten with encryption before removal."
          )}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "다른 기기에는 적용되지 않으며, 각 기기에서 별도로 초기화해야 합니다.",
            "This does not affect other devices; reset each device separately."
          )}
        </div>
        <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
          <div className="flex items-center justify-between text-xs text-nkc-muted">
            <span>{t("저장소 사용량(추정)", "Storage usage (estimate)")}</span>
            <span>
              {formatBytes(vaultUsageBytes)} / {formatBytes(vaultUsageMaxBytes)}
            </span>
          </div>
          <div className="mt-2 h-2 w-full rounded-full bg-nkc-border">
            <div
              className="h-2 rounded-full bg-nkc-accent"
              style={{
                width: `${Math.min(
                  100,
                  Math.round((vaultUsageBytes / vaultUsageMaxBytes) * 100)
                )}%`,
              }}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRequestWipeChat}
            disabled={chatWipeBusy}
            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
          >
            {chatWipeBusy ? t("처리 중...", "Working...") : t("채팅 내역 초기화", "Reset chat history")}
          </button>
          <button
            type="button"
            onClick={onRequestWipeMedia}
            disabled={mediaWipeBusy}
            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
          >
            {mediaWipeBusy ? t("처리 중...", "Working...") : t("미디어 초기화", "Reset media")}
          </button>
        </div>
      </section>
    </div>
  );
}

