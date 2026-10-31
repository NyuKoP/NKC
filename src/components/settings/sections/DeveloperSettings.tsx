import { AlertTriangle, Check, Route, ShieldCheck } from "lucide-react";
import SettingsBackHeader from "../SettingsBackHeader";

export type TorBridgeMode = "off" | "auto" | "force";

type DeveloperSettingsProps = {
  t: (ko: string, en: string) => string;
  onBack: () => void;
  bridgeMode: TorBridgeMode;
  savedBridgeMode: TorBridgeMode;
  onBridgeModeChange: (value: TorBridgeMode) => void;
  onSave: () => void | Promise<void>;
  busy: boolean;
  torRunning: boolean;
  saveMessage: string;
};

const choices: Array<{
  value: TorBridgeMode;
  ko: string;
  en: string;
  descriptionKo: string;
  descriptionEn: string;
  recommended?: boolean;
}> = [
  {
    value: "auto",
    ko: "자동",
    en: "Automatic",
    descriptionKo:
      "먼저 Tor에 직접 연결하고, 차단이 감지되면 앱에 포함된 브리지로 다시 시도합니다. 일반 환경과 제한된 환경을 함께 사용하는 경우 권장합니다.",
    descriptionEn:
      "Connects to Tor directly first, then retries with bundled bridges when blocking is detected. Recommended across normal and restricted networks.",
    recommended: true,
  },
  {
    value: "off",
    ko: "직접 연결만",
    en: "Direct only",
    descriptionKo:
      "브리지를 사용하지 않습니다. 시작 준비가 가장 단순하지만 Tor가 차단된 네트워크에서는 연결되지 않을 수 있습니다.",
    descriptionEn:
      "Never uses a bridge. Startup is simpler, but the connection can fail on networks that block Tor.",
  },
  {
    value: "force",
    ko: "항상 브리지 사용",
    en: "Always use bridges",
    descriptionKo:
      "처음부터 앱에 포함된 브리지로 연결합니다. Tor 차단 우회에 유용하지만 준비 시간이 더 길고 자원을 더 사용할 수 있습니다.",
    descriptionEn:
      "Uses a bundled bridge from the beginning. Useful for bypassing Tor blocking, but startup can take longer and use more resources.",
  },
];

export default function DeveloperSettings({
  t,
  onBack,
  bridgeMode,
  savedBridgeMode,
  onBridgeModeChange,
  onSave,
  busy,
  torRunning,
  saveMessage,
}: DeveloperSettingsProps) {
  const dirty = bridgeMode !== savedBridgeMode;

  return (
    <div className="mt-6 grid gap-5">
      <SettingsBackHeader
        title={t("개발자 기능", "Developer features")}
        backLabel={t("뒤로", "Back")}
        onBack={onBack}
      />

      <section className="overflow-hidden rounded-xl border border-nkc-divider bg-nkc-surface">
        <div className="flex items-start gap-3 border-b border-nkc-divider bg-nkc-panelMuted px-4 py-3.5">
          <AlertTriangle size={17} className="mt-0.5 shrink-0 text-nkc-warning" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-nkc-text">
              {t("고급 연결 설정", "Advanced connection settings")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-nkc-muted">
              {t(
                "네트워크 제한을 알고 있을 때만 변경하세요. 일반적인 환경에서는 ‘자동’을 권장합니다.",
                "Change these options only when you understand the network restrictions. Automatic is recommended for most people."
              )}
            </p>
          </div>
        </div>

        <div className="p-5">
        <fieldset className="min-w-0">
          <legend className="mb-2 flex items-center gap-2 text-sm font-semibold text-nkc-text">
            <Route size={16} className="text-nkc-accent" aria-hidden="true" />
            {t("Tor 브리지 정책", "Tor bridge policy")}
          </legend>
          <p className="mt-1 text-xs leading-5 text-nkc-muted">
            {t(
              "브리지는 Tor 사용 사실이 쉽게 차단되는 네트워크에서 Tor로 들어가는 대체 입구입니다.",
              "A bridge is an alternate entry into Tor for networks where ordinary Tor connections are easily blocked."
            )}
          </p>

          <div className="mt-3 grid gap-2">
            {choices.map((choice) => {
              const selected = bridgeMode === choice.value;

              return (
                <label
                  key={choice.value}
                  className={`relative flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                    selected
                      ? "border-nkc-accent bg-nkc-selected"
                      : "border-nkc-divider bg-nkc-panel hover:bg-nkc-hover"
                  }`}
                >
                  <input
                    type="radio"
                    name="tor-bridge-mode"
                    value={choice.value}
                    checked={selected}
                    data-testid={`developer-bridge-mode-${choice.value}`}
                    onChange={() => onBridgeModeChange(choice.value)}
                    className="mt-1 accent-nkc-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-xs font-semibold text-nkc-text">
                      {t(choice.ko, choice.en)}
                      {choice.recommended ? (
                        <span className="rounded-full bg-nkc-brandMist px-2 py-0.5 text-[10px] font-semibold text-nkc-brandDeep">
                          {t("권장", "Recommended")}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-nkc-muted">
                      {t(choice.descriptionKo, choice.descriptionEn)}
                    </span>
                  </span>
                  {selected ? <Check size={15} className="mt-0.5 shrink-0 text-nkc-accent" aria-hidden="true" /> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
        </div>
      </section>

      <section className="rounded-xl border border-nkc-divider bg-nkc-panelMuted px-4 py-3.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-nkc-text">
          <ShieldCheck size={16} className="text-nkc-accent" aria-hidden="true" />
          {t("저장 및 적용 시", "When saved and applied")}
        </div>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[11px] leading-[18px] text-nkc-muted">
          <li>
            {t(
              torRunning
                ? "현재 Tor 연결과 회로를 다시 구성합니다. 잠시 메시지 송수신이 대기할 수 있습니다."
                : "다음 Tor 연결부터 선택한 정책을 사용합니다.",
              torRunning
                ? "The active Tor connection and circuits are rebuilt. Message delivery can pause briefly."
                : "The selected policy is used the next time Tor connects."
            )}
          </li>
          <li>{t("Onion 주소와 계정 키는 변경되지 않습니다.", "Your Onion address and account keys do not change.")}</li>
          <li>{t("대기 중인 메시지는 삭제되지 않고 경로가 준비되면 다시 시도됩니다.", "Queued messages are kept and retried after the route is ready.")}</li>
          <li>{t("종단간 암호화와 친구 신뢰 상태에는 영향을 주지 않습니다.", "End-to-end encryption and friend trust status are unaffected.")}</li>
        </ul>
        <p className="mt-3 border-t border-nkc-divider pt-3 text-[11px] leading-[18px] text-nkc-muted">
          {t(
            "브리지는 연결 성공을 보장하거나 익명성 등급을 바꾸는 기능이 아닙니다. 현재 버전은 앱에 포함된 브리지만 사용하며 사용자 지정 주소 입력은 지원하지 않습니다.",
            "Bridges do not guarantee connectivity or change an anonymity level. This version uses bundled bridges only and does not accept custom bridge addresses."
          )}
        </p>
      </section>

      <div className="flex items-center justify-end gap-3">
        {saveMessage ? (
          <span role="status" className="text-xs text-nkc-muted">
            {saveMessage}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="developer-save-button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-nkc bg-nkc-accent px-4 py-2.5 text-xs font-semibold text-nkc-accentText transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t("적용 중...", "Applying...") : t("저장 및 적용", "Save and apply")}
        </button>
      </div>
    </div>
  );
}
