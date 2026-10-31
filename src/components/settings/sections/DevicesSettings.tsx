import { Check, Clock, MonitorSmartphone, Radio, AlertCircle } from "lucide-react";
import type {
  PairingRequest,
  RendezvousPairingStatus,
  SyncCodeState,
} from "../../../devices/devicePairing";
import type { DeviceSyncTransportPolicy } from "../../../preferences";
import type { DeviceAuthorization } from "../../../devices/deviceApprovals";
import SettingsBackHeader from "../SettingsBackHeader";
import ToggleSwitch from "../ToggleSwitch";

type Translate = (ko: string, en: string) => string;

type DevicesSettingsProps = {
  historyPolicy: "ALL" | "LAST_30_DAYS" | "NEW_ONLY" | "";
  onHistoryPolicyChange: (value: "ALL" | "LAST_30_DAYS" | "NEW_ONLY" | "") => void;
  approvedDevices: DeviceAuthorization[];
  currentDeviceId: string;
  canRevoke: boolean;
  onUnlinkDevice: (deviceId: string) => Promise<void>;
  freshnessBusy: boolean;
  onFreshnessAction: (action: "enroll" | "recover") => Promise<void>;
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
  rendezvousBaseUrlDraft: string;
  onRendezvousBaseUrlChange: (value: string) => void;
  onRendezvousBaseUrlSave: () => void | Promise<void>;
  rendezvousSaveStatus: "idle" | "saving" | "saved" | "error";
  rendezvousError: string;
  rendezvousUseOnionProxy: boolean;
  onRendezvousUseOnionChange: (value: boolean) => void;
  hostRendezvousStatus: RendezvousPairingStatus;
  guestRendezvousStatus: RendezvousPairingStatus;
};

const statusLabel = (
  value: RendezvousPairingStatus,
  t: Translate
) => {
  if (value === "connecting") return t("연결 중", "Connecting");

  if (value === "exchanging") return t("신호 교환 중", "Exchanging");

  if (value === "connected") return t("연결됨", "Connected");

  if (value === "error") return t("오류", "Error");

  return t("대기", "Idle");
};

export default function DevicesSettings({
  historyPolicy, onHistoryPolicyChange, approvedDevices, currentDeviceId, canRevoke, onUnlinkDevice,
  freshnessBusy, onFreshnessAction,
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
  rendezvousBaseUrlDraft,
  onRendezvousBaseUrlChange,
  onRendezvousBaseUrlSave,
  rendezvousSaveStatus,
  rendezvousError,
  rendezvousUseOnionProxy,
  onRendezvousUseOnionChange,
  hostRendezvousStatus,
  guestRendezvousStatus,
}: DevicesSettingsProps) {
  return (
    <div className="mt-6 grid gap-5" data-testid="devices-settings">
      <SettingsBackHeader title={t("기기/동기화", "Devices / Sync")} backLabel={t("뒤로", "Back")} onBack={onBack} />
      <div className="flex items-start gap-3 px-1">
        <MonitorSmartphone size={22} className="mt-0.5 shrink-0 text-nkc-accent" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-nkc-text">{t("내 기기 연결", "Connect your devices")}</h2>
          <p className="mt-1 text-sm leading-relaxed text-nkc-muted">{t("기존 기기에서 코드를 생성하고, 새 기기에서 입력하세요. 연결이 끝날 때까지 두 기기를 켜 두세요.", "Generate a code on your existing device and enter it on the new one. Keep both devices online until pairing completes.")}</p>
        </div>
      </div>

      {approvedDevices.length > 0 && <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <h3 className="text-sm font-semibold text-nkc-text">{t("승인된 기기", "Approved devices")}</h3>
        <ul className="mt-3 grid gap-3">
          {approvedDevices.map((device, index) => <li key={device.deviceId} className="flex items-center justify-between gap-3 text-sm">
            <span>{device.deviceId === currentDeviceId ? t("이 기기", "This device") : `${t("기기", "Device")} ${index + 1}`} · {device.role === "primary" ? t("계정 Root", "Account Root") : t("추가 기기", "Linked device")}
              {device.kind === "DEVICE_REVOKED" ? ` · ${t("해제됨", "Unlinked")}` : ""}</span>
            {canRevoke && device.deviceId !== currentDeviceId && device.kind === "DEVICE_ADDED" &&
              <button type="button" data-testid={`device-unlink-${device.deviceId}`} onClick={() => void onUnlinkDevice(device.deviceId)} className="rounded-nkc border border-nkc-border px-3 py-2">{t("해제", "Unlink")}</button>}
          </li>)}
        </ul>
        <p className="mt-3 text-xs text-nkc-muted">{window.nkcExperimental?.freshnessWitness === true
          ? t("실험용 기기 권한 보호 모드에서는 최초 기기에서 승인과 해제를 진행해야 합니다.", "Experimental authority protection requires the original device for approval and unlink.")
          : t("승인된 기기에서 새 기기를 추가하거나 다른 기기를 해제할 수 있습니다. 최초 기기가 없어도 사용할 수 있으며, 해제 시 이 기기에 확인된 하위 기기의 승인과 기존 대화 기록은 유지됩니다. 아직 알려지지 않은 기기의 승인은 유지되지 않을 수 있습니다.", "Any approved device can add or unlink another device without the original device. Unlinking retains known descendant approvals and existing history. Approvals for devices not yet known here may not survive.")}</p>
      </section>}
      {canRevoke && window.nkcExperimental?.freshnessWitness === true && <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <h3 className="text-sm font-semibold text-nkc-text">{t("기기 권한 보호", "Protect device authority")}</h3>
        <p className="mt-2 text-xs text-nkc-muted">{t("기존 계정은 한 번 등록하세요. 백업을 복원했거나 승인이 중단되면 최신 권한을 복구하세요. 대화 기록은 삭제하지 않습니다.", "Enroll an existing account once. After restoring a backup or blocked approval, recover current authority. Conversation history is retained.")}</p>
        <div className="mt-3 flex gap-3">
          <button type="button" disabled={freshnessBusy} onClick={() => void onFreshnessAction("enroll")} className="rounded-nkc border border-nkc-border px-3 py-2 disabled:opacity-50">{t("보호 등록", "Enroll protection")}</button>
          <button type="button" disabled={freshnessBusy} onClick={() => void onFreshnessAction("recover")} className="rounded-nkc border border-nkc-border px-3 py-2 disabled:opacity-50">{t("최신 권한 복구", "Recover current authority")}</button>
        </div>
      </section>}





      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">
          {t("새 기기 추가(코드 생성)", "Add new device (Generate code)")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "이 기기에서 새 기기를 승인합니다. 최초 연결에서 계정 식별값을 설정하며, 각 기기의 개인키는 복사되지 않습니다. 연결은 Tor를 사용합니다.",
            "Approve a new device here. The first link establishes the account identity; each device keeps its own private keys. Linking uses Tor."
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onGenerateSyncCode}
            data-testid="device-generate-code"
            disabled={approvedDevices.length > 0 && !canRevoke}
            className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-accentText"
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
            <div data-testid="device-generated-code" className="mt-1 break-all font-mono text-sm text-nkc-text">{syncCodeState.code}</div>
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
              <span className="font-mono text-nkc-text">{pairingRequest.deviceId.slice(0, 12)}</span>
              <span className="text-xs text-nkc-muted">{formatTimestamp(pairingRequest.ts)}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onApproveRequest()}
                data-testid="device-approve-request"
                disabled={pairingRequestBusy}
                className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-accentText disabled:opacity-50"
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
              <div className="mt-2 text-xs nkc-error">{pairingRequestError}</div>
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
            "새 기기에서 코드를 입력하면 기존 기기로 승인 요청이 전송됩니다.",
            "Enter the code on the new device to request linking."
          )}
        </div>
        <div className="mt-4 grid gap-2">
          <label className="grid gap-2 text-sm text-nkc-text">{t("초기 대화 기록", "Initial history")}
            <select aria-label={t("초기 대화 기록", "Initial history")} value={historyPolicy}
              disabled={linkBusy} onChange={event => onHistoryPolicyChange(event.target.value as DevicesSettingsProps["historyPolicy"])}
              className="rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
              <option value="">{t("범위를 선택하세요", "Choose history scope")}</option>
              <option value="ALL">{t("전체", "All history")}</option>
              <option value="LAST_30_DAYS">{t("최근 30일", "Last 30 days")}</option>
              <option value="NEW_ONLY">{t("새 메시지만", "New messages only")}</option>
            </select>
          </label>
          <input
            aria-label={t("동기화 코드", "Sync code")}
            data-testid="device-link-code"
            value={linkCodeDraft}
            onChange={(event) => {
              setLinkCodeDraft(event.target.value);

              if (linkStatus !== "idle") {
                setLinkStatus("idle");
                setLinkMessage("");
              }
            }}
            placeholder="NKC-DEVICE2-…"
            className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 font-mono text-sm text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
          />
          <button
            type="button"
            onClick={() => void onSubmitLink()}
            data-testid="device-request-link"
            disabled={linkBusy || !linkCodeDraft.trim() || (linkCodeDraft.startsWith("NKC-DEVICE2-") && !historyPolicy)}
            className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-accentText disabled:opacity-50"
          >
            {linkBusy ? t("연결 중...", "Connecting...") : t("연결 요청", "Request link")}
          </button>
        </div>
        {linkStatus !== "idle" ? (
          <div className={`mt-2 text-xs ${linkStatusClass}`}>{linkMessage}</div>
        ) : null}
      </section>
    {approvedDevices.length === 0 && <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">
          {t("레거시 기기 동기화 전송 정책", "Legacy device sync transport policy")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "이전 설정은 보존되지만 Direct 연결은 이 버전에서 차단됩니다. 새 기기 연결은 계정 Root와 Tor를 사용합니다.",
            "Legacy settings are preserved, but Direct connections are blocked in this release. New device linking uses Account Root and Tor."
          )}
        </div>
        <div className="mt-4 grid gap-3">
          <div role="status" className="text-sm font-semibold text-nkc-text">
            {deviceSyncTransportPolicy === "directOnly"
              ? t("이전 설정: Direct 전용 · 이 버전에서는 연결 불가", "Saved legacy setting: Direct only · unavailable in this release")
              : t("현재 네트워크 모드 따름 · 적용됨", "Following current network mode · applied")}
          </div>
          {deviceSyncTransportPolicy === "directOnly" && (
            <button
              type="button"
              className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-sm font-semibold text-nkc-accentText"
              onClick={() => void onChangeDeviceSyncTransportPolicy("followNetwork")}
            >
              {t("현재 네트워크 모드 사용", "Use current network mode")}
            </button>
          )}
        </div>
      </section>}

<section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-nkc-text">
          <Radio size={16} className="text-nkc-accent" aria-hidden="true" />
          {t("기기 연결 서버", "Device pairing server")}
        </div>
        <div className="mt-2 text-xs text-nkc-muted">
          {t(
            "레거시 연결 흐름의 고급 설정입니다. 현재 Root 연결은 Tor를 사용합니다. 서버 설정은 현재 계정에만 저장됩니다.",
            "Advanced settings for legacy linking. Current Root linking uses Tor. Server settings are saved for this account only."
          )}
        </div>
        <div className="mt-4 grid gap-2">
          <label htmlFor="rendezvous-server-url" className="text-xs font-medium text-nkc-text">{t("서버 주소", "Server address")}</label>
          <div className="flex flex-wrap items-start gap-2">
          <input
            id="rendezvous-server-url"
            data-testid="rendezvous-server-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            disabled={rendezvousSaveStatus === "saving"}
            aria-invalid={Boolean(rendezvousError)}
            aria-describedby="rendezvous-save-feedback"
            value={rendezvousBaseUrlDraft}
            onChange={(event) => onRendezvousBaseUrlChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void onRendezvousBaseUrlSave(); } }}
            placeholder="https://example.com"
            className="min-w-0 flex-1 basis-48 rounded-lg border border-nkc-border bg-nkc-panel px-3 py-2.5 text-sm text-nkc-text outline-none focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-60"
          />
          <button type="button" data-testid="rendezvous-save" onClick={() => void onRendezvousBaseUrlSave()} disabled={rendezvousSaveStatus === "saving"} className="rounded-lg bg-nkc-accent px-4 py-2.5 text-sm font-medium text-nkc-accentText transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:cursor-wait disabled:opacity-60">
            {rendezvousSaveStatus === "saving" ? t("저장 중…", "Saving…") : t("저장", "Save")}
          </button>
          </div>
          <div id="rendezvous-save-feedback" data-testid="rendezvous-save-feedback" role={rendezvousError ? "alert" : "status"} className={`flex min-h-5 items-center gap-1.5 text-xs ${rendezvousError ? "nkc-error" : "text-nkc-muted"}`}>
            {rendezvousError ? <><AlertCircle size={14} aria-hidden="true" />{rendezvousError}</> : rendezvousSaveStatus === "saved" ? <><Check size={14} aria-hidden="true" />{t("저장했습니다.", "Saved.")}</> : t("서버 주소를 변경한 뒤 저장을 눌러주세요.", "Save after changing the server address.")}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-nkc-border pt-4 text-xs text-nkc-text">
            <span>{t("신호 요청을 Onion 프록시로 전송", "Send signaling through Onion proxy")}</span>
            <ToggleSwitch
              label={t("신호 요청을 Onion 프록시로 전송", "Send signaling through Onion proxy")}
              checked={rendezvousUseOnionProxy}
              disabled={rendezvousSaveStatus === "saving"}
              testId="rendezvous-onion"
              onChange={onRendezvousUseOnionChange}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-nkc-border pt-3 text-xs" aria-live="polite">
            <div><div className="text-nkc-muted">{t("기존 기기", "Existing device")}</div><div className="mt-1 font-medium text-nkc-text">{statusLabel(hostRendezvousStatus, t)}</div></div>
            <div><div className="text-nkc-muted">{t("새 기기", "New device")}</div><div className="mt-1 font-medium text-nkc-text">{statusLabel(guestRendezvousStatus, t)}</div></div>
          </div>
        </div>
      </section>
    </div>
  );
}
