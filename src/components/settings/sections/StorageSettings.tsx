import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type StorageSettingsProps = {
  t: Translate;
  onBack: () => void;
  storageUsage: {
    chatBytes: number;
    mediaBytes: number;
    pendingBytes: number;
    totalBytes: number;
  };
  formatBytes: (value: number) => string;
  chatWipeBusy: boolean;
  mediaWipeBusy: boolean;
  onRequestWipeChat: () => void;
  onRequestWipeMedia: () => void;
  onNavigateToPending: () => void;
};

export default function StorageSettings({
  t,
  onBack,
  storageUsage,
  formatBytes,
  chatWipeBusy,
  mediaWipeBusy,
  onRequestWipeChat,
  onRequestWipeMedia,
  onNavigateToPending,
}: StorageSettingsProps) {
  const { chatBytes, mediaBytes, pendingBytes, totalBytes } = storageUsage;
  const hasData = totalBytes > 0;
  const toPercent = (value: number) => (hasData ? (value / totalBytes) * 100 : 0);

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
            "삭제는 되돌릴 수 없습니다. 남은 데이터는 삭제 전에 암호화로 덮어씁니다.",
            "Deletion cannot be undone. Data is overwritten with encryption before removal."
          )}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "다른 기기에는 영향을 주지 않으며, 각 기기에서 따로 초기화해야 합니다.",
            "This does not affect other devices; reset each device separately."
          )}
        </div>

        <div className="mt-4">
          <div className="flex items-end justify-between gap-4">
            <div className="text-sm font-semibold text-nkc-text">
              {t("로컬 저장소 사용량", "Local storage usage")}
            </div>
            <div className="text-sm font-semibold text-nkc-text">{formatBytes(totalBytes)}</div>
          </div>

          {hasData ? (
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-nkc-border">
              <div className="flex h-full w-full">
                {chatBytes > 0 && (
                  <div
                    className="h-full bg-nkc-accent"
                    style={{ width: `${toPercent(chatBytes)}%` }}
                  />
                )}
                {mediaBytes > 0 && (
                  <div
                    className="h-full bg-nkc-card"
                    style={{ width: `${toPercent(mediaBytes)}%` }}
                  />
                )}
                {pendingBytes > 0 && (
                  <div
                    className="h-full bg-nkc-danger"
                    style={{ width: `${toPercent(pendingBytes)}%` }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-xs text-nkc-muted">
              {t("사용 중인 데이터 없음", "No data in use")}
            </div>
          )}

          <div className="mt-3">
            <div className="flex items-center justify-between border-b border-nkc-border py-2 text-xs">
              <div className="text-nkc-text">{t("채팅 데이터", "Chat data")}</div>
              <div className="font-medium text-nkc-text">{formatBytes(chatBytes)}</div>
            </div>
            <div className="flex items-center justify-between border-b border-nkc-border py-2 text-xs">
              <div className="text-nkc-text">{t("미디어 파일", "Media files")}</div>
              <div className="font-medium text-nkc-text">{formatBytes(mediaBytes)}</div>
            </div>
            <button
              type="button"
              onClick={onNavigateToPending}
              className="flex w-full items-center justify-between py-2 text-left text-xs text-nkc-text hover:text-nkc-accent"
            >
              <div>
                <div>{t("전송 대기 메시지", "Pending messages")}</div>
                <div className="text-[11px] text-nkc-muted">{t("관리: 위험 구역", "Manage: Danger zone")}</div>
              </div>
              <div className="flex items-center gap-3">
                <div className="font-medium text-nkc-text">{formatBytes(pendingBytes)}</div>
                <div className="text-nkc-muted">&gt;</div>
              </div>
            </button>
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
