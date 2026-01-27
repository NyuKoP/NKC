import type { AppPreferences, AppPreferencesPatch } from "../../../preferences";
import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type NotificationsSettingsProps = {
  t: Translate;
  onBack: () => void;
  appPrefs: AppPreferences;
  prefsDisabled: boolean;
  notificationsDisabled: boolean;
  onUpdateAppPrefs: (patch: AppPreferencesPatch) => void | Promise<void>;
};

export default function NotificationsSettings({
  t,
  onBack,
  appPrefs,
  prefsDisabled,
  notificationsDisabled,
  onUpdateAppPrefs,
}: NotificationsSettingsProps) {
  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader title={t("알림", "Notifications")} backLabel={t("뒤로", "Back")} onBack={onBack} />
      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
            <div>
              <div className="text-sm font-medium text-nkc-text">
                {t("알림 사용", "Notifications enabled")}
              </div>
              <div className="text-xs text-nkc-muted">
                {t("새 메시지 알림을 표시합니다.", "Show new message notifications.")}
              </div>
            </div>
            <input
              type="checkbox"
              checked={appPrefs.notifications.enabled}
              disabled={prefsDisabled}
              onChange={(e) =>
                void onUpdateAppPrefs({
                  notifications: { enabled: e.target.checked },
                })
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-nkc-text">
                {t("알림 내용 숨기기", "Hide notification content")}
              </div>
              <div className="text-xs text-nkc-muted">
                {t("\"새 메시지\"로만 표시합니다.", "Show only \"New message\".")}
              </div>
            </div>
            <input
              type="checkbox"
              checked={appPrefs.notifications.hideContent}
              disabled={prefsDisabled || notificationsDisabled}
              onChange={(e) =>
                void onUpdateAppPrefs({
                  notifications: { hideContent: e.target.checked },
                })
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}

