import type { ReactNode } from "react";
import { Clock } from "lucide-react";
import type { OnionStatus } from "../../../net/onionControl";
import type { NetConfig, OnionNetwork } from "../../../net/netConfig";
import type { ConnectionChoice } from "../settingsTypes";
import SettingsBackHeader from "../SettingsBackHeader";

type Translate = (ko: string, en: string) => string;

type DotState = "running" | "starting" | "stopped" | "error";

type NetworkSettingsProps = {
  t: Translate;
  onBack: () => void;
  connectionChoice: ConnectionChoice;
  onConnectionChoiceChange: (choice: ConnectionChoice) => void | Promise<void>;
  onionStatus: OnionStatus | null;
  getDotState: (kind: "tor" | "lokinet", status: OnionStatus | null) => DotState;
  getDotClass: (state: DotState) => string;
  buildComponentLabel: (state: NetConfig["tor"]) => string;
  netConfig: NetConfig;
  runtimeStatusTooltip: string;
  runtimeStatusIcon: ReactNode;
  activeRouteLabel: string;
  runtimeSocksLabel: string;
  runtimeStateLabel: string;
  runtimeNetworkLabel: string;
  runtimeErrorLabel: string;
  torUpdateStatus: string;
  lokinetUpdateStatus: string;
  torErrorLabel: string | null;
  lokinetErrorLabel: string | null;
  torInstallBusy: boolean;
  torStatusBusy: boolean;
  torCheckBusy: boolean;
  torApplyBusy: boolean;
  torUninstallBusy: boolean;
  lokinetInstallBusy: boolean;
  lokinetStatusBusy: boolean;
  lokinetApplyBusy: boolean;
  lokinetUninstallBusy: boolean;
  torUpdateAvailable: boolean;
  lokinetUpdateAvailable: boolean;
  isComponentReady: (state: NetConfig["tor"]) => boolean;
  onInstall: (network: OnionNetwork) => void | Promise<void>;
  onTorStatus: () => void | Promise<void>;
  onLokinetStatus: () => void | Promise<void>;
  onConnectOnion: (network?: OnionNetwork) => void | Promise<void>;
  onDisconnectOnion: (network?: OnionNetwork) => void | Promise<void>;
  onCheckUpdates: () => void | Promise<void>;
  onApplyUpdate: (network: OnionNetwork) => void | Promise<void>;
  onUninstall: (network: OnionNetwork) => void | Promise<void>;
  routeInfo: { pathLabel: string; description: string };
  connectionDescription: string;
  selfOnionHopConnected: number;
  selfOnionHopTarget: number;
  selfOnionRouteLabel: string;
  onSelfOnionHopChange: (value: number) => void;
  showDirectWarning: boolean;
  torAddress: string;
  lokinetAddress: string;
  onCopyAddress: (value: string, label: string) => void | Promise<void>;
  onionEnabledDraft: boolean;
  setOnionEnabledDraft: (value: boolean) => void;
  proxyAuto: boolean;
  proxyUrlDraft: string;
  proxyUrlError: string;
  onProxyUrlChange: (value: string) => void;
  canSaveOnion: boolean;
  onSaveOnion: () => void | Promise<void>;
  saveMessage: string;
};

export default function NetworkSettings({
  t,
  onBack,
  connectionChoice,
  onConnectionChoiceChange,
  onionStatus,
  getDotState,
  getDotClass,
  buildComponentLabel,
  netConfig,
  runtimeStatusTooltip,
  runtimeStatusIcon,
  activeRouteLabel,
  runtimeSocksLabel,
  runtimeStateLabel,
  runtimeNetworkLabel,
  runtimeErrorLabel,
  torUpdateStatus,
  lokinetUpdateStatus,
  torErrorLabel,
  lokinetErrorLabel,
  torInstallBusy,
  torStatusBusy,
  torCheckBusy,
  torApplyBusy,
  torUninstallBusy,
  lokinetInstallBusy,
  lokinetStatusBusy,
  lokinetApplyBusy,
  lokinetUninstallBusy,
  torUpdateAvailable,
  lokinetUpdateAvailable,
  isComponentReady,
  onInstall,
  onTorStatus,
  onLokinetStatus,
  onConnectOnion,
  onDisconnectOnion,
  onCheckUpdates,
  onApplyUpdate,
  onUninstall,
  routeInfo,
  connectionDescription,
  selfOnionHopConnected,
  selfOnionHopTarget,
  selfOnionRouteLabel,
  onSelfOnionHopChange,
  showDirectWarning,
  torAddress,
  lokinetAddress,
  onCopyAddress,
  onionEnabledDraft,
  setOnionEnabledDraft,
  proxyAuto,
  proxyUrlDraft,
  proxyUrlError,
  onProxyUrlChange,
  canSaveOnion,
  onSaveOnion,
  saveMessage,
}: NetworkSettingsProps) {
  const runtime = onionStatus?.runtime;
  const torConnected = runtime?.status === "running" && runtime.network === "tor";
  const lokinetConnected = runtime?.status === "running" && runtime.network === "lokinet";

  return (
    <div className="mt-6 grid gap-6">
      <SettingsBackHeader title={t("네트워크", "Network")} backLabel={t("뒤로", "Back")} onBack={onBack} />

      <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
        <div className="text-sm font-semibold text-nkc-text">{t("연결 방식", "Connection mode")}</div>
        <div className="mt-3 grid gap-2">
          <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text">
            <div className="flex items-start gap-3">
              <input
                id="network-mode-directP2P"
                type="radio"
                name="network-mode"
                className="mt-1"
                checked={connectionChoice === "directP2P"}
                onChange={() => void onConnectionChoiceChange("directP2P")}
                data-testid="network-mode-directP2P"
              />
              <label htmlFor="network-mode-directP2P">
                <div className="text-sm font-medium text-nkc-text">Direct P2P</div>
                <div className="text-xs text-nkc-muted">
                  {t("프록시 없이 직접 연결", "Direct connection without proxy")}
                </div>
              </label>
            </div>
          </div>

          <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <input
                  id="network-mode-torOnion"
                  type="radio"
                  name="network-mode"
                  className="mt-1"
                  checked={connectionChoice === "torOnion"}
                  onChange={() => void onConnectionChoiceChange("torOnion")}
                  data-testid="network-mode-torOnion"
                />
                <div>
                  <label
                    htmlFor="network-mode-torOnion"
                    className="flex items-center gap-2 text-sm font-medium text-nkc-text"
                  >
                    <span>Tor Onion</span>
                    <span
                      title={t("Tor 상태", "Tor status")}
                      className={`inline-flex h-2 w-2 rounded-full ${getDotClass(
                        getDotState("tor", onionStatus)
                      )} cursor-pointer`}
                      tabIndex={0}
                    />
                  </label>
                  <div className="text-xs text-nkc-muted">
                    {t("SOCKS 기반 · 앱 트래픽만", "SOCKS-based · app traffic only")}
                  </div>
                </div>
              </div>
              <div className="text-xs text-nkc-muted">{buildComponentLabel(netConfig.tor)}</div>
            </div>
            {connectionChoice === "torOnion" ? (
              <div className="mt-3 border-t border-nkc-border pt-3">
                <div className="flex items-start justify-between gap-4 text-xs text-nkc-muted">
                  <div className="flex items-center gap-1">
                    <span title={runtimeStatusTooltip} className="inline-flex items-center cursor-pointer" tabIndex={0}>
                      {runtimeStatusIcon}
                    </span>
                    <span>
                      {activeRouteLabel}
                      {runtimeSocksLabel}
                    </span>
                  </div>
                  <div className="text-right">
                    <div>
                      {runtimeStateLabel} · {runtimeNetworkLabel}
                    </div>
                    {runtimeErrorLabel ? <div className="text-red-300">{runtimeErrorLabel}</div> : null}
                  </div>
                </div>
                {torUpdateStatus ? (
                  <div className="mt-2 max-w-full break-words text-xs text-nkc-muted">{torUpdateStatus}</div>
                ) : null}
                {netConfig.tor.detail ? (
                  <div className="mt-2 max-h-24 max-w-full overflow-auto overflow-x-hidden whitespace-pre-wrap break-all text-[11px] text-nkc-muted">
                    {netConfig.tor.detail}
                  </div>
                ) : null}
                {torErrorLabel ? (
                  <div className="mt-2 max-w-full break-words text-xs text-red-300">{torErrorLabel}</div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!netConfig.tor.installed ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void onInstall("tor")}
                        disabled={torInstallBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {torInstallBusy ? t("처리 중...", "Working...") : t("Tor 다운로드/설치", "Download/Install Tor")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onTorStatus()}
                        disabled={torStatusBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {torStatusBusy ? t("처리 중...", "Working...") : t("상태 확인", "Check status")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void (torConnected ? onDisconnectOnion("tor") : onConnectOnion("tor"))
                        }
                        disabled={torConnected ? torInstallBusy : torInstallBusy || !isComponentReady(netConfig.tor)}
                        className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                      >
                        {torConnected ? t("연결 해제", "Disconnect") : t("연결", "Connect")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onCheckUpdates()}
                        disabled={torCheckBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {torCheckBusy ? t("처리 중...", "Working...") : t("업데이트 확인", "Check updates")}
                      </button>
                      {torUpdateAvailable ? (
                        <button
                          type="button"
                          onClick={() => void onApplyUpdate("tor")}
                          disabled={torApplyBusy}
                          className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                        >
                          {torApplyBusy ? t("처리 중...", "Working...") : t("업데이트 적용", "Apply update")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void onUninstall("tor")}
                        disabled={torUninstallBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {torUninstallBusy ? t("처리 중...", "Working...") : t("제거", "Uninstall")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onTorStatus()}
                        disabled={torStatusBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {torStatusBusy ? t("처리 중...", "Working...") : t("상태 확인", "Check status")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <input
                  id="network-mode-lokinetOnion"
                  type="radio"
                  name="network-mode"
                  className="mt-1"
                  checked={connectionChoice === "lokinetOnion"}
                  onChange={() => void onConnectionChoiceChange("lokinetOnion")}
                  data-testid="network-mode-lokinetOnion"
                />
                <div>
                  <label
                    htmlFor="network-mode-lokinetOnion"
                    className="flex items-center gap-2 text-sm font-medium text-nkc-text"
                  >
                    <span>Lokinet Onion</span>
                    <span
                      title={t("Lokinet 상태", "Lokinet status")}
                      className={`inline-flex h-2 w-2 rounded-full ${getDotClass(
                        getDotState("lokinet", onionStatus)
                      )} cursor-pointer`}
                      tabIndex={0}
                    />
                    <span className="text-xs text-nkc-muted">{t("⚠ 고급", "⚠ Advanced")}</span>
                  </label>
                  <div className="text-xs text-nkc-muted">
                    {t("Exit/VPN 기반 · 앱 전용 라우팅", "Exit/VPN based · app-only routing")}
                  </div>
                </div>
              </div>
              <div className="text-xs text-nkc-muted">{buildComponentLabel(netConfig.lokinet)}</div>
            </div>
            {connectionChoice === "lokinetOnion" ? (
              <div className="mt-3 border-t border-nkc-border pt-3">
                <div className="flex items-start justify-between gap-4 text-xs text-nkc-muted">
                  <div className="flex items-center gap-1">
                    <span title={runtimeStatusTooltip} className="inline-flex items-center cursor-pointer" tabIndex={0}>
                      {runtimeStatusIcon}
                    </span>
                    <span>
                      {activeRouteLabel}
                      {runtimeSocksLabel}
                    </span>
                  </div>
                  <div className="text-right">
                    <div>
                      {runtimeStateLabel} · {runtimeNetworkLabel}
                    </div>
                    {runtimeErrorLabel ? <div className="text-red-300">{runtimeErrorLabel}</div> : null}
                  </div>
                </div>
                <div className="mt-2 text-xs text-nkc-muted">
                  {netConfig.lokinet.installed ? t("상태: 설치됨", "Status: installed") : t("상태: 미설치", "Status: not installed")}
                </div>
                {lokinetUpdateStatus ? (
                  <div className="mt-2 max-w-full break-words text-xs text-nkc-muted">{lokinetUpdateStatus}</div>
                ) : null}
                {netConfig.lokinet.detail ? (
                  <div className="mt-2 max-h-24 max-w-full overflow-auto overflow-x-hidden whitespace-pre-wrap break-all text-[11px] text-nkc-muted">
                    {netConfig.lokinet.detail}
                  </div>
                ) : null}
                {lokinetErrorLabel ? (
                  <div className="mt-2 max-w-full break-words text-xs text-red-300">{lokinetErrorLabel}</div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!netConfig.lokinet.installed ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void onInstall("lokinet")}
                        disabled={lokinetInstallBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {lokinetInstallBusy ? t("처리 중...", "Working...") : t("설치", "Install")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onLokinetStatus()}
                        disabled={lokinetStatusBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {lokinetStatusBusy ? t("처리 중...", "Working...") : t("상태 확인", "Check status")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void (lokinetConnected ? onDisconnectOnion("lokinet") : onConnectOnion("lokinet"))
                        }
                        disabled={
                          lokinetConnected
                            ? lokinetInstallBusy
                            : lokinetInstallBusy || !isComponentReady(netConfig.lokinet)
                        }
                        className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                      >
                        {lokinetConnected ? t("연결 해제", "Disconnect") : t("연결", "Connect")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          lokinetUpdateAvailable ? void onApplyUpdate("lokinet") : void onCheckUpdates()
                        }
                        disabled={lokinetUpdateAvailable ? lokinetApplyBusy : torCheckBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {lokinetUpdateAvailable
                          ? lokinetApplyBusy
                            ? t("처리 중...", "Working...")
                            : t("업데이트 적용", "Apply update")
                          : torCheckBusy
                            ? t("처리 중...", "Working...")
                            : t("업데이트 확인", "Check updates")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onUninstall("lokinet")}
                        disabled={lokinetUninstallBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {lokinetUninstallBusy ? t("처리 중...", "Working...") : t("제거", "Uninstall")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onLokinetStatus()}
                        disabled={lokinetStatusBusy}
                        className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                      >
                        {lokinetStatusBusy ? t("처리 중...", "Working...") : t("상태 확인", "Check status")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text">
            <div className="flex items-start gap-3">
              <input
                id="network-mode-selfOnion"
                type="radio"
                name="network-mode"
                className="mt-1"
                checked={connectionChoice === "selfOnion"}
                onChange={() => void onConnectionChoiceChange("selfOnion")}
                data-testid="network-mode-selfOnion"
              />
              <label htmlFor="network-mode-selfOnion">
                <div className="text-sm font-medium text-nkc-text">{t("내부 Onion", "Built-in Onion")}</div>
                <div className="text-xs text-nkc-muted">
                  {t("내장 Onion 경로(N hops)", "Built-in Onion route (N hops)")}
                </div>
              </label>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-nkc-muted">
          <span className="rounded-full border border-nkc-border bg-nkc-panel px-2 py-1" data-testid="effective-mode-label">
            {routeInfo.pathLabel}
          </span>
          <span>{routeInfo.description}</span>
        </div>
        <div className="mt-3 text-xs text-nkc-muted">{connectionDescription}</div>
        {netConfig.mode === "selfOnion" ? (
          <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-nkc-text">{t("Hop 설정", "Hop settings")}</div>
                <div className="text-xs text-nkc-muted">
                  hops: {selfOnionHopConnected}/{selfOnionHopTarget} · {selfOnionRouteLabel}
                </div>
              </div>
              <select
                value={selfOnionHopTarget}
                onChange={(e) => onSelfOnionHopChange(Number(e.target.value))}
                className="rounded-nkc border border-nkc-border bg-nkc-panel px-2 py-1 text-xs text-nkc-text"
              >
                <option value={3}>3 hops</option>
                <option value={4}>4 hops</option>
              </select>
            </div>
          </div>
        ) : null}
        {showDirectWarning ? (
          <div
            className="mt-3 rounded-nkc border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
            data-testid="direct-p2p-warning"
          >
            <div>
              {t(
                "Direct P2P는 상대에게 IP가 노출될 수 있습니다. 위험을 이해하는 경우에만 사용하세요.",
                "Direct P2P exposes your IP to the peer. Enable only if you understand the risk."
              )}
            </div>
          </div>
        ) : null}
      </section>

      {netConfig.mode === "onionRouter" ? (
        <>
          <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-nkc-text">
                  {t("IP 보호 모드 사용", "Enable IP protection")}
                </div>
                <div className="text-xs text-nkc-muted">
                  {t(
                    "direct P2P를 차단하고, 실패 시 네트워크를 중지합니다.",
                    "Blocks direct P2P and stops the network on failure."
                  )}
                </div>
              </div>
              <input
                type="checkbox"
                checked={onionEnabledDraft}
                onChange={(e) => setOnionEnabledDraft(e.target.checked)}
              />
            </div>
          </section>

          <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-nkc-text">
              <span>{t("프록시 URL", "Proxy URL")}</span>
              {proxyAuto ? (
                <span
                  title={t("프록시 미설정/자동", "Proxy unset/auto")}
                  className="inline-flex items-center cursor-pointer"
                  tabIndex={0}
                >
                  <Clock size={12} className="text-nkc-muted" />
                </span>
              ) : null}
            </div>
            <div className="mt-2">
              <input
                value={proxyUrlDraft}
                onChange={(e) => onProxyUrlChange(e.target.value)}
                placeholder={t("예: socks5://127.0.0.1:9050", "e.g. socks5://127.0.0.1:9050")}
                className={`w-full rounded-nkc border bg-nkc-panel px-3 py-2 text-sm text-nkc-text placeholder:text-nkc-muted ${
                  proxyUrlError ? "border-red-400/60" : "border-nkc-border"
                }`}
                aria-invalid={proxyUrlError ? "true" : "false"}
                data-testid="proxy-url-input"
              />
              {proxyUrlError ? (
                <div className="mt-2 text-xs text-red-300" data-testid="proxy-url-error">
                  {proxyUrlError}
                </div>
              ) : null}
            </div>
            <div className="mt-2 text-xs text-nkc-muted">
              {t(
                "포트까지 포함한 URL을 입력하세요. 비워두면 자동 감지합니다.",
                "Include the port. Leave blank to auto-detect."
              )}
            </div>
          </section>
        </>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void onSaveOnion()}
          className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
          disabled={netConfig.mode === "onionRouter" && onionEnabledDraft && !canSaveOnion}
        >
          {t("저장", "Save")}
        </button>
      </div>

      {saveMessage ? <div className="text-right text-xs text-nkc-muted">{saveMessage}</div> : null}
    </div>
  );
}
