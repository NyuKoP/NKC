import { Clock } from "lucide-react";
import type { PairingRequest, SyncCodeState } from "../../../devices/devicePairing";
import type { DeviceSyncTransportPolicy } from "../../../preferences";
import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type DevicesSettingsProps = {
  t: Translate;
  onBack: () => void;
  onGenerateSyncCode: () => void;
  onCopySyncCode: () => void | Promise<void>;
  syncCodeState: SyncCodeState | null;
  syncCodeExpired: boolean;
  syncCodeRemainingMs: number;
  formatCountdown: (valueMs: number) => string;
  pairingRequest: PairingRequest | null;
  formatTimestamp: (value: number) => string;
  pairingRequestBusy: boolean;
  pairingRequestError: string;
  onApproveRequest: () => void | Promise<void>;
  onRejectRequest: () => void;
  deviceSyncTransportPolicy: DeviceSyncTransportPolicy;
  onChangeDeviceSyncTransportPolicy: (value: DeviceSyncTransportPolicy) => void | Promise<void>;
  linkCodeDraft: string;
  setLinkCodeDraft: (value: string) => void;
  linkStatus: "idle" | "pending" | "approved" | "rejected" | "error";
  setLinkStatus: (value: "idle" | "pending" | "approved" | "rejected" | "error") => void;
  setLinkMessage: (value: string) => void;
  linkBusy: boolean;
  linkStatusClass: string;
  linkMessage: string;
  onSubmitLink: () => void | Promise<void>;
};

export default function DevicesSettings({
  t,
  onBack,
  onGenerateSyncCode,
  onCopySyncCode,
  syncCodeState,
  syncCodeExpired,
  syncCodeRemainingMs,
  formatCountdown,
  pairingRequest,
  formatTimestamp,
  pairingRequestBusy,
  pairingRequestError,
  onApproveRequest,
  onRejectRequest,
  deviceSyncTransportPolicy,
  onChangeDeviceSyncTransportPolicy,
  linkCodeDraft,
  setLinkCodeDraft,
  linkStatus,
  setLinkStatus,
  setLinkMessage,
  linkBusy,
  linkStatusClass,
  linkMessage,
  onSubmitLink,
}: DevicesSettingsProps) {
  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader
        title={t("기기/동기화", "Devices / Sync")}
        backLabel={t("뒤로", "Back")}
        onBack={onBack}
      />

      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">
          {t("기기 동기화 정책", "Device sync policy")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "동기화 연결에서 사용할 전송 정책을 선택하세요.",
            "Choose which transport policy device sync should use."
          )}
        </div>
        <div className="mt-4 grid gap-2">
          <label className="flex items-center gap-2 text-xs text-nkc-text">
            <input
              type="radio"
              name="device-sync-transport-policy"
              checked={deviceSyncTransportPolicy === "directOnly"}
              onChange={() => void onChangeDeviceSyncTransportPolicy("directOnly")}
            />
            <span>{t("직접 연결 전용(권장)", "Direct only (Recommended)")}</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-nkc-text">
            <input
              type="radio"
              name="device-sync-transport-policy"
              checked={deviceSyncTransportPolicy === "followNetwork"}
              onChange={() => void onChangeDeviceSyncTransportPolicy("followNetwork")}
            />
            <span>{t("현재 네트워크 모드 따름", "Follow current network mode")}</span>
          </label>
        </div>
      </section>

      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">
          {t("새 기기 추가(코드 생성)", "Add new device (Generate code)")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "기존 기기에서 코드를 생성한 뒤 새 기기에 입력하세요.",
            "Generate a code on an existing device and enter it on the new device."
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onGenerateSyncCode}
            className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg"
          >
            {t("코드 생성", "Generate code")}
          </button>
          {syncCodeState ? (
            <button
              type="button"
              onClick={() => void onCopySyncCode()}
              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
            >
              {t("코드 복사", "Copy code")}
            </button>
          ) : null}
        </div>
        {syncCodeState ? (
          <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
            <div className="text-xs text-nkc-muted">{t("동기화 코드", "Sync code")}</div>
            <div className="mt-1 font-mono text-lg text-nkc-text">{syncCodeState.code}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-nkc-muted">
              <Clock size={14} />
              {syncCodeState.used
                ? t("이미 사용됨", "Already used")
                : syncCodeExpired
                  ? t("만료됨", "Expired")
                  : `${t("남은 시간", "Time left")}: ${formatCountdown(syncCodeRemainingMs)}`}
            </div>
          </div>
        ) : null}

        {pairingRequest ? (
          <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-4 py-3">
            <div className="text-xs text-nkc-muted">{t("연결 요청", "Pairing request")}</div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-mono text-nkc-text">
                {pairingRequest.deviceId.slice(0, 12)}
              </span>
              <span className="text-xs text-nkc-muted">{formatTimestamp(pairingRequest.ts)}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onApproveRequest()}
                disabled={pairingRequestBusy}
                className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
              >
                {t("승인", "Approve")}
              </button>
              <button
                type="button"
                onClick={onRejectRequest}
                disabled={pairingRequestBusy}
                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel disabled:opacity-50"
              >
                {t("거절", "Reject")}
              </button>
            </div>
            {pairingRequestError ? (
              <div className="mt-2 text-xs text-red-300">{pairingRequestError}</div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">
          {t("기기 연결(코드 입력)", "Link device (Enter code)")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "새 기기에서 코드를 입력해 연결을 요청합니다.",
            "Enter the code on the new device to request linking."
          )}
        </div>
        <div className="mt-4 grid gap-2">
          <input
            value={linkCodeDraft}
            onChange={(event) => {
              setLinkCodeDraft(event.target.value);
              if (linkStatus !== "idle") {
                setLinkStatus("idle");
                setLinkMessage("");
              }
            }}
            placeholder="NKC-SYNC-XXXX-XXXX"
            className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
          />
          <button
            type="button"
            onClick={() => void onSubmitLink()}
            disabled={linkBusy}
            className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
          >
            {linkBusy ? t("연결 중...", "Connecting...") : t("연결 요청", "Request link")}
          </button>
        </div>
        {linkStatus !== "idle" ? (
          <div className={`mt-2 text-xs ${linkStatusClass}`}>{linkMessage}</div>
        ) : null}
      </section>
    </div>
  );
}

