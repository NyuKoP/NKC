import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, KeyRound, Lock, Users } from "lucide-react";
import type { UserProfile } from "../db/repo";
import {
  clearChatHistory,
  deleteAllMedia,
  getVaultUsage,
  listConversations,
  listMessagesByConv,
  listProfiles,
} from "../db/repo";
import { useAppStore } from "../app/store";
import {
  defaultPrivacyPrefs,
  getDirectP2PRiskAck,
  getPrivacyPrefs,
  setDirectP2PRiskAck,
  setPrivacyPrefs,
} from "../security/preferences";
import { isPinAvailable } from "../security/pin";
import {
  applyOnionUpdate,
  checkOnionUpdates,
  getOnionStatus,
  installOnion,
  onOnionProgress,
  setOnionMode,
  uninstallOnion,
} from "../net/onionControl";
import type { OnionStatus } from "../net/onionControl";
import { useNetConfigStore } from "../net/netConfigStore";
import { getRouteInfo } from "../net/routeInfo";
import type { NetworkMode } from "../net/mode";
import type { OnionNetwork } from "../net/netConfig";
import { getConnectionStatus, onConnectionStatus } from "../net/connectionStatus";
import { validateProxyUrl } from "../net/proxyControl";
import {
  demoteToSecondary,
  getDeviceRole,
  getOrCreateDeviceId,
  getRoleEpoch,
  promoteToPrimary,
  type DeviceRole,
} from "../security/deviceRole";
import Avatar from "./Avatar";
import ConfirmDialog from "./ConfirmDialog";

type LocalizedLabel = { ko: string; en: string };

const themeOptions: { value: "dark" | "light"; label: LocalizedLabel }[] = [
  { value: "dark", label: { ko: "다크", en: "Dark" } },
  { value: "light", label: { ko: "라이트", en: "Light" } },
];

const modeOptions: { value: NetworkMode; label: LocalizedLabel }[] = [
  { value: "directP2P", label: { ko: "Direct P2P", en: "Direct P2P" } },
  { value: "onionRouter", label: { ko: "릴레이 / Onion", en: "Relay / Onion" } },
  { value: "selfOnion", label: { ko: "내부 Onion", en: "Built-in Onion" } },
];

type SettingsView =
  | "main"
  | "privacy"
  | "theme"
  | "friends"
  | "danger"
  | "network"
  | "help"
  | "storage"
  | "devices";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserProfile;

  onSaveProfile: (payload: {
    displayName: string;
    status: string;
    theme: "dark" | "light";
  }) => Promise<void>;

  onUploadPhoto: (file: File) => Promise<void>;
  onLock: () => void;

  pinEnabled: boolean;
  onSetPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  onDisablePin: () => Promise<void>;
  onOpenRecovery: () => void;

  hiddenFriends: UserProfile[];
  blockedFriends: UserProfile[];
  onUnhideFriend: (id: string) => Promise<void>;
  onUnblockFriend: (id: string) => Promise<void>;

  onLogout: () => void;
  onWipe: () => void;
};

export default function SettingsDialog({
  open,
  onOpenChange,
  user,
  onSaveProfile,
  onUploadPhoto,
  onLock,
  pinEnabled,
  onSetPin,
  onDisablePin,
  onOpenRecovery,
  hiddenFriends,
  blockedFriends,
  onUnhideFriend,
  onUnblockFriend,
  onLogout,
  onWipe,
}: SettingsDialogProps) {
  const [view, setView] = useState<SettingsView>("main");
  const {
    config: netConfig,
    setMode,
    setProxy,
    setOnionEnabled,
    setOnionNetwork,
    setComponentState,
    setLastUpdateCheckAt,
    setSelfOnionMinRelays,
  } = useNetConfigStore();

  // profile
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState(user.status);
  const [theme, setTheme] = useState<"dark" | "light">(user.theme);
  const [editing, setEditing] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(user.displayName);
  const [statusDraft, setStatusDraft] = useState(user.status);

  // privacy
  const [privacyPrefs, setPrivacyPrefsState] = useState(defaultPrivacyPrefs);

  // pin
  const [pinDraft, setPinDraft] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinAvailable, setPinAvailable] = useState(true);

  // network
  const [onionEnabledDraft, setOnionEnabledDraft] = useState(netConfig.onionEnabled);
  const [onionNetworkDraft, setOnionNetworkDraft] = useState(netConfig.onionSelectedNetwork);
  const [onionStatus, setOnionStatus] = useState<OnionStatus | null>(null);
  const [directP2PAcked, setDirectP2PAcked] = useState(false);
  const [directP2PConfirmOpen, setDirectP2PConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<NetworkMode | null>(null);
  const [proxyUrlDraft, setProxyUrlDraft] = useState(netConfig.onionProxyUrl);
  const [proxyUrlError, setProxyUrlError] = useState("");
  const [torInstallBusy, setTorInstallBusy] = useState(false);
  const [torCheckBusy, setTorCheckBusy] = useState(false);
  const [torApplyBusy, setTorApplyBusy] = useState(false);
  const [torUninstallBusy, setTorUninstallBusy] = useState(false);
  const [lokinetInstallBusy, setLokinetInstallBusy] = useState(false);
  const [lokinetStatusBusy, setLokinetStatusBusy] = useState(false);
  const [lokinetApplyBusy, setLokinetApplyBusy] = useState(false);
  const [lokinetUninstallBusy, setLokinetUninstallBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(getConnectionStatus());
  const [chatWipeBusy, setChatWipeBusy] = useState(false);
  const [mediaWipeBusy, setMediaWipeBusy] = useState(false);
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [wipeConfirmType, setWipeConfirmType] = useState<"chat" | "media" | null>(
    null
  );
  const [vaultUsageBytes, setVaultUsageBytes] = useState(0);
  const [vaultUsageMaxBytes, setVaultUsageMaxBytes] = useState(50 * 1024 * 1024);

  const language = useAppStore((state) => state.ui.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setData = useAppStore((state) => state.setData);
  const setSelectedConv = useAppStore((state) => state.setSelectedConv);
  const userProfileState = useAppStore((state) => state.userProfile);
  const addToast = useAppStore((state) => state.addToast);

  const t = (ko: string, en: string) => (language === "en" ? en : ko);
  const tl = (label: LocalizedLabel) => (language === "en" ? label.en : label.ko);

  const handleProxyUrlChange = (value: string) => {
    setProxyUrlDraft(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setProxyUrlError("");
      setProxy(netConfig.onionProxyEnabled, "");
      return;
    }
    try {
      const { normalized } = validateProxyUrl(trimmed);
      setProxyUrlError("");
      setProxy(netConfig.onionProxyEnabled, normalized);
    } catch {
      setProxyUrlError(t("유효하지 않은 프록시 URL입니다.", "Invalid proxy URL."));
    }
  };

  // misc
  const [saveMessage, setSaveMessage] = useState("");
  const [deviceInfo, setDeviceInfo] = useState<{
    deviceId: string;
    role: DeviceRole;
    epoch: number;
  } | null>(null);
  const [promoteConfirmOpen, setPromoteConfirmOpen] = useState(false);
  const [demoteConfirmOpen, setDemoteConfirmOpen] = useState(false);

  useEffect(() => {
    setDisplayName(user.displayName);
    setStatus(user.status);
    setTheme(user.theme);
    setDisplayNameDraft(user.displayName);
    setStatusDraft(user.status);
    setEditing(false);
  }, [user]);

  useEffect(() => {
    if (!open) return;
    setView("main");
    setOnionEnabledDraft(netConfig.onionEnabled);
    setOnionNetworkDraft(netConfig.onionSelectedNetwork);
    setProxyUrlDraft(netConfig.onionProxyUrl);
    setProxyUrlError("");
    getPrivacyPrefs()
      .then(setPrivacyPrefsState)
      .catch((e) => console.error("Failed to load privacy prefs", e));
    getDirectP2PRiskAck()
      .then(setDirectP2PAcked)
      .catch(() => setDirectP2PAcked(false));
  }, [open, netConfig.onionEnabled, netConfig.onionSelectedNetwork, netConfig.onionProxyUrl]);

  useEffect(() => {
    if (view !== "devices") return;
    const deviceId = getOrCreateDeviceId();
    const role = getDeviceRole();
    const epoch = getRoleEpoch();
    setDeviceInfo({ deviceId, role, epoch });
  }, [view]);

  useEffect(() => {
    if (!open) return;
    isPinAvailable()
      .then(setPinAvailable)
      .catch(() => setPinAvailable(false));
  }, [open]);

  useEffect(() => {
    const unsubscribe = onConnectionStatus(setConnectionStatus);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const refresh = async () => {
      try {
        const status = await getOnionStatus();
        setOnionStatus(status);
        setComponentState("tor", status.components.tor);
        setComponentState("lokinet", status.components.lokinet);
      } catch (error) {
        console.error("Failed to load onion status", error);
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 2500);
    const unsubscribe = onOnionProgress((payload) => {
      setComponentState(payload.network, payload.status);
      setOnionStatus((prev) =>
        prev
          ? {
              ...prev,
              components: { ...prev.components, [payload.network]: payload.status },
            }
          : prev
      );
    });
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [open, setComponentState]);

  useEffect(() => {
    if (!open) return;
    const refreshUsage = async () => {
      try {
        const usage = await getVaultUsage();
        setVaultUsageBytes(usage.bytes);
        if (usage.bytes > vaultUsageMaxBytes) {
          setVaultUsageMaxBytes(Math.max(usage.bytes, 50 * 1024 * 1024));
        }
      } catch (error) {
        console.error("Failed to read vault usage", error);
      }
    };
    void refreshUsage();
  }, [open, vaultUsageMaxBytes]);

  useEffect(() => {
    if (!saveMessage) return;
    const t = window.setTimeout(() => setSaveMessage(""), 2000);
    return () => window.clearTimeout(t);
  }, [saveMessage]);

  const updatePrivacy = async (next: typeof privacyPrefs) => {
    setPrivacyPrefsState(next);
    try {
      await setPrivacyPrefs(next);
    } catch (e) {
      console.error("Failed to save privacy prefs", e);
    }
  };

  const refreshOnionStatus = async () => {
    try {
      const status = await getOnionStatus();
      setOnionStatus(status);
      setComponentState("tor", status.components.tor);
      setComponentState("lokinet", status.components.lokinet);
    } catch (error) {
      console.error("Failed to refresh onion status", error);
    }
  };

  const handleCheckUpdates = async () => {
    if (torCheckBusy) return;
    setTorCheckBusy(true);
    try {
      const status = await checkOnionUpdates();
      setOnionStatus(status);
      setComponentState("tor", status.components.tor);
      setComponentState("lokinet", status.components.lokinet);
      setLastUpdateCheckAt(Date.now());
      setSaveMessage(t("업데이트 확인 완료", "Update check complete"));
    } catch (error) {
      console.error("Failed to check onion updates", error);
      setSaveMessage(t("업데이트 확인 실패", "Update check failed"));
    } finally {
      setTorCheckBusy(false);
    }
  };

  const handleApplyUpdate = async (network: "tor" | "lokinet") => {
    if (network === "tor" && torApplyBusy) return;
    if (network === "lokinet" && lokinetApplyBusy) return;
    if (network === "tor") setTorApplyBusy(true);
    if (network === "lokinet") setLokinetApplyBusy(true);
    try {
      await applyOnionUpdate(network);
      await refreshOnionStatus();
      setSaveMessage(t("업데이트 적용 완료", "Update applied"));
    } catch (error) {
      console.error("Failed to apply onion update", error);
      setSaveMessage(t("업데이트 적용 실패", "Update failed"));
    } finally {
      if (network === "tor") setTorApplyBusy(false);
      if (network === "lokinet") setLokinetApplyBusy(false);
    }
  };

  const handleInstall = async (network: "tor" | "lokinet") => {
    if (network === "tor" && torInstallBusy) return;
    if (network === "lokinet" && lokinetInstallBusy) return;
    if (network === "tor") setTorInstallBusy(true);
    if (network === "lokinet") setLokinetInstallBusy(true);
    try {
      await installOnion(network);
      await refreshOnionStatus();
      if (network === "tor") {
        try {
          const status = await checkOnionUpdates();
          setOnionStatus(status);
          setComponentState("tor", status.components.tor);
          setComponentState("lokinet", status.components.lokinet);
          setLastUpdateCheckAt(Date.now());
        } catch (error) {
          console.error("Failed to check onion updates after install", error);
        }
      }
      setSaveMessage(
        network === "tor" ? t("Tor 설치 완료", "Tor installed") : t("Lokinet 설치 완료", "Lokinet installed")
      );
    } catch (error) {
      console.error("Failed to install onion component", error);
      setSaveMessage(
        network === "tor" ? t("Tor 설치 실패", "Tor install failed") : t("Lokinet 설치 실패", "Lokinet install failed")
      );
    } finally {
      if (network === "tor") setTorInstallBusy(false);
      if (network === "lokinet") setLokinetInstallBusy(false);
    }
  };

  const handleUninstall = async (network: "tor" | "lokinet") => {
    if (network === "tor" && torUninstallBusy) return;
    if (network === "lokinet" && lokinetUninstallBusy) return;
    if (network === "tor") setTorUninstallBusy(true);
    if (network === "lokinet") setLokinetUninstallBusy(true);
    try {
      await uninstallOnion(network);
      await refreshOnionStatus();
      setSaveMessage(
        network === "tor" ? t("Tor 제거 완료", "Tor removed") : t("Lokinet 제거 완료", "Lokinet removed")
      );
    } catch (error) {
      console.error("Failed to uninstall onion component", error);
      setSaveMessage(
        network === "tor" ? t("Tor 제거 실패", "Tor remove failed") : t("Lokinet 제거 실패", "Lokinet remove failed")
      );
    } finally {
      if (network === "tor") setTorUninstallBusy(false);
      if (network === "lokinet") setLokinetUninstallBusy(false);
    }
  };

  const handleSaveOnion = async () => {
    try {
      if (netConfig.mode === "onionRouter") {
        await setOnionMode(true, onionNetworkDraft);
        setOnionEnabled(onionEnabledDraft);
        setOnionNetwork(onionNetworkDraft);
      } else {
        await setOnionMode(false, onionNetworkDraft);
        setOnionEnabled(false);
        setOnionNetwork(onionNetworkDraft);
      }
      setSaveMessage(t("저장됨", "Saved"));
    } catch (error) {
      console.error("Failed to save onion settings", error);
      setSaveMessage(t("저장에 실패했습니다.", "Save failed."));
    }
  };

  const handleConnectOnion = async (network: OnionNetwork) => {
    try {
      setOnionNetworkDraft(network);
      setOnionEnabledDraft(true);
      await setOnionMode(true, network);
      setOnionEnabled(true);
      setOnionNetwork(network);
      setSaveMessage(t("연결 중...", "Connecting..."));
      await refreshOnionStatus();
    } catch (error) {
      console.error("Failed to start onion runtime", error);
      setSaveMessage(t("연결 실패", "Connect failed"));
    }
  };

  const handleDisconnectOnion = async (network: OnionNetwork) => {
    try {
      await setOnionMode(false, network);
      setOnionEnabled(false);
      setSaveMessage(t("연결 해제됨", "Disconnected"));
      await refreshOnionStatus();
    } catch (error) {
      console.error("Failed to stop onion runtime", error);
      setSaveMessage(t("연결 해제 실패", "Disconnect failed"));
    }
  };

  const handleModeChange = async (next: NetworkMode) => {
    if (next === "directP2P" && !directP2PAcked) {
      setPendingMode(next);
      setDirectP2PConfirmOpen(true);
      return;
    }
    setMode(next);
  };

  const handleConfirmDirectP2P = async () => {
    await setDirectP2PRiskAck(true);
    setDirectP2PAcked(true);
    if (pendingMode === "directP2P") {
      setMode("directP2P");
    }
    setPendingMode(null);
  };

  const formatBytes = (value: number) => {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  };

  const refreshAppData = async () => {
    const profiles = await listProfiles();
    const user = profiles.find((profile) => profile.kind === "user") || null;
    const friends = profiles.filter((profile) => profile.kind === "friend");
    const conversations = await listConversations();
    const messagesBy: Record<string, Awaited<ReturnType<typeof listMessagesByConv>>> = {};
    for (const conv of conversations) {
      messagesBy[conv.id] = await listMessagesByConv(conv.id);
    }
    setData({ user, friends, convs: conversations, messagesByConv: messagesBy });
    if (userProfileState && user?.id !== userProfileState.id) {
      setSelectedConv(null);
    }
  };

  const renderBackHeader = (title: string) => (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={() => setView("main")}
        className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
      >
        <ChevronLeft size={14} />
        {t("뒤로", "Back")}
      </button>
      <span className="text-sm font-semibold text-nkc-text">{title}</span>
      <div className="w-12" />
    </div>
  );

  const startEdit = () => {
    setDisplayNameDraft(displayName);
    setStatusDraft(status);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDisplayNameDraft(displayName);
    setStatusDraft(status);
    setEditing(false);
  };

  const saveEdit = async () => {
    try {
      await onSaveProfile({
        displayName: displayNameDraft.trim() || displayName,
        status: statusDraft,
        theme,
      });
      setDisplayName(displayNameDraft.trim() || displayName);
      setStatus(statusDraft);
      setEditing(false);
      setSaveMessage(t("저장되었습니다.", "Saved."));
    } catch (e) {
      console.error("Failed to save profile", e);
      setSaveMessage(t("저장에 실패했습니다.", "Save failed."));
    }
  };

  const handleSetPin = async () => {
    setPinError("");
    if (!pinAvailable) {
      setPinError(t("PIN lock is unavailable on this platform/build.", "PIN lock is unavailable on this platform/build."));
      return;
    }
    const value = pinDraft.trim();
    if (value.length < 4) {
      setPinError(t("PIN은 최소 4자리 이상이어야 합니다.", "PIN must be at least 4 digits."));
      return;
    }
    const result = await onSetPin(value);
    if (!result.ok) {
      setPinError(result.error || t("PIN 설정에 실패했습니다.", "Failed to set PIN."));
      return;
    }
    setPinDraft("");
    setSaveMessage(t("PIN이 설정되었습니다.", "PIN set."));
  };

  const handleTogglePin = async (next: boolean) => {
    setPinError("");
    if (!pinAvailable) {
      setPinError(t("PIN lock is unavailable on this platform/build.", "PIN lock is unavailable on this platform/build."));
      return;
    }
    if (!next) {
      await onDisablePin();
      setPinDraft("");
      setSaveMessage(t("PIN이 해제되었습니다.", "PIN disabled."));
    }
  };


  const routeInfo = getRouteInfo(netConfig.mode, netConfig);
  const runtime = onionStatus?.runtime;
  const runtimeLabel = runtime
    ? runtime.status === "running"
      ? t("경로: 연결됨", "Route: connected")
      : runtime.status === "starting"
        ? t("경로: 시작 중", "Route: starting")
        : runtime.status === "failed"
          ? t("경로: 실패", "Route: failed")
          : t("경로: 대기", "Route: idle")
    : t("경로: 확인 필요", "Route: check required");
  const runtimeStateLabel = runtime
    ? runtime.status === "running"
      ? t("상태: 실행 중", "Status: running")
      : runtime.status === "starting"
        ? t("상태: 시작 중", "Status: starting")
        : runtime.status === "failed"
          ? t("상태: 실패", "Status: failed")
          : t("상태: 대기", "Status: idle")
    : t("상태: 확인 필요", "Status: check required");
  const runtimeNetworkLabel = runtime?.network
    ? `${t("네트워크", "Network")}: ${runtime.network}`
    : `${t("네트워크", "Network")}: -`;
  const runtimeSocksLabel =
    runtime && runtime.status === "running" && runtime.network === "tor" && runtime.socksPort
      ? ` · SOCKS 127.0.0.1:${runtime.socksPort}`
      : "";
  const runtimeErrorLabel = runtime?.error ? `${t("실패", "Failed")}: ${runtime.error}` : "";

  const formatOnionError = (value?: string) => {
    if (!value) return null;
    if (value === "PINNED_HASH_MISSING")
      return t("실패: 검증 데이터 없음", "Failed: missing verification data");
    const trimmed = value.split("| details=")[0].trim();
    const match = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    const code = match?.[1] ?? "";
    const message = match?.[2] ?? trimmed;
    const label =
      code === "DOWNLOAD_FAILED"
        ? t("다운로드 실패", "Download failed")
        : code === "HASH_MISMATCH"
          ? t("검증 실패", "Hash mismatch")
          : code === "EXTRACT_FAILED"
            ? t("압축 해제 실패", "Extraction failed")
            : code === "PERMISSION_DENIED"
              ? t("권한 부족", "Permission denied")
              : code === "BINARY_MISSING"
                ? t("실행 파일 없음", "Binary missing")
                : code === "FS_ERROR"
                  ? t("파일 시스템 오류", "File system error")
                  : code === "PINNED_HASH_MISSING"
                    ? t("검증 데이터 없음", "Missing verification data")
                    : code === "UNKNOWN_ERROR"
                      ? t("알 수 없는 오류", "Unknown error")
                      : null;
    const shortMessage = label ? `${label}${message ? ` · ${message}` : ""}` : message;
    return `${t("실패", "Failed")}: ${shortMessage}`;
  };

  const selfOnionHopTarget = netConfig.selfOnionMinRelays;
  const selfOnionHopConnected =
    connectionStatus.transport === "selfOnion" && connectionStatus.state === "connected"
      ? selfOnionHopTarget
      : 0;
  const selfOnionRouteLabel =
    connectionStatus.transport === "selfOnion"
      ? connectionStatus.state === "connected"
        ? t("경로: 연결됨", "Route: connected")
        : connectionStatus.state === "connecting"
          ? t("경로: 연결 중", "Route: connecting")
          : connectionStatus.state === "failed"
            ? t("경로: 실패", "Route: failed")
            : t("경로: 대기", "Route: idle")
      : t("경로: 대기", "Route: idle");

  const buildComponentLabel = (state: typeof netConfig.tor) => {
    if (state.status === "downloading") return t("다운로드 중", "Downloading");
    if (state.status === "installing") return t("설치 중", "Installing");
    if (state.status === "failed") return t("실패", "Failed");
    if (state.installed) return t("설치됨", "Installed");
    return t("미설치", "Not installed");
  };

  const isComponentReady = (state: typeof netConfig.tor) =>
    state.installed && state.status === "ready";

  const torUpdateAvailable = Boolean(
    netConfig.tor.latest && netConfig.tor.latest !== netConfig.tor.version
  );
  const lokinetUpdateAvailable = Boolean(
    netConfig.lokinet.latest && netConfig.lokinet.latest !== netConfig.lokinet.version
  );
  const torUpdateStatus = netConfig.lastUpdateCheckAtMs
    ? netConfig.tor.error === "PINNED_HASH_MISSING"
      ? t("검증 데이터 없음", "Missing verification data")
      : torUpdateAvailable
        ? `${t("업데이트 가능", "Update available")}: ${netConfig.tor.latest}`
        : t("최신 상태", "Up to date")
    : "";
  const lokinetUpdateStatus = netConfig.lastUpdateCheckAtMs
    ? netConfig.lokinet.error === "PINNED_HASH_MISSING"
      ? t("검증 데이터 없음", "Missing verification data")
      : lokinetUpdateAvailable
        ? `${t("업데이트 가능", "Update available")}: ${netConfig.lokinet.latest}`
        : t("최신 상태", "Up to date")
    : "";
  const torErrorLabel = formatOnionError(netConfig.tor.error);
  const lokinetErrorLabel = formatOnionError(netConfig.lokinet.error);

  const canSaveOnion =
    !onionEnabledDraft ||
    (onionNetworkDraft === "tor" ? netConfig.tor.installed : netConfig.lokinet.installed);

  const connectionDescription =
    netConfig.mode === "onionRouter"
      ? t(
          "외부 Onion: Tor 또는 Lokinet 경로를 사용합니다.",
          "External Onion: uses a Tor or Lokinet route."
        )
      : netConfig.mode === "directP2P"
        ? t(
            "Direct P2P: 프록시 없이 직접 연결을 시도합니다.",
            "Direct P2P: attempts a direct connection without a proxy."
          )
        : t("내부 Onion: 앱 내부 hop 경로를 사용합니다.", "Built-in Onion: uses in-app hops.");

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 h-[80vh] w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
          <Dialog.Title className="text-lg font-semibold text-nkc-text">
            {t("설정", "Settings")}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {t("설정 대화상자", "Settings dialog")}
          </Dialog.Description>

          {/* MAIN */}
          {view === "main" && (
            <div className="mt-6 grid gap-6">
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex items-start gap-4">
                  <Avatar name={displayName} avatarRef={user.avatarRef} size={64} />
                  <div className="min-w-0 flex-1">
                    {!editing ? (
                      <>
                        <div className="truncate text-sm font-semibold text-nkc-text">
                          {displayName}
                        </div>
                        <div className="mt-1 truncate text-xs text-nkc-muted">
                          {status ? status : t("상태 메시지가 없습니다.", "No status message.")}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={startEdit}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                          >
                            {t("편집", "Edit")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="text-sm text-nkc-text">
                          {t("표시 이름", "Display name")}
                          <input
                            value={displayNameDraft}
                            onChange={(e) => setDisplayNameDraft(e.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                          />
                        </label>
                        <label className="mt-3 block text-sm text-nkc-text">
                          {t("상태 메시지", "Status message")}
                          <input
                            value={statusDraft}
                            onChange={(e) => setStatusDraft(e.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                          />
                        </label>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <label className="cursor-pointer rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel">
                            {t("사진 업로드", "Upload photo")}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                try {
                                  await onUploadPhoto(file);
                                  setSaveMessage(t("사진이 업로드되었습니다.", "Photo uploaded."));
                                } catch (err) {
                                  console.error("Upload failed", err);
                                  setSaveMessage(t("사진 업로드에 실패했습니다.", "Photo upload failed."));
                                } finally {
                                  e.currentTarget.value = "";
                                }
                              }}
                            />
                          </label>

                          <button
                            type="button"
                            onClick={saveEdit}
                            className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg"
                          >
                            {t("저장", "Save")}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                          >
                            {t("취소", "Cancel")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setView("friends")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("친구 관리", "Friend management")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("network")}
                    data-testid="settings-network-button"
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("네트워크 설정", "Network settings")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("devices")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    <Users size={16} className="text-nkc-muted" />
                    {t("디바이스 / 동기화", "Devices / Sync")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("privacy")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("보안 / 개인정보", "Security / Privacy")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("theme")}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("테마", "Theme")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("storage")}
                    className="flex w-full items-center gap-3 border-t border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("저장소 관리", "Storage management")}
                  </button>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setView("help")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("도움말", "Help")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("danger")}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-red-200 hover:bg-nkc-panel"
                  >
                    {t("위험 구역", "Danger zone")}
                  </button>
                </div>
              </section>

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                    {t("닫기", "Close")}
                  </button>
                </Dialog.Close>
              </div>

              {saveMessage ? (
                <div className="text-right text-xs text-nkc-muted">{saveMessage}</div>
              ) : null}
            </div>
          )}

          {/* THEME */}
          {view === "theme" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("테마", "Theme"))}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex flex-wrap gap-3">
                  {themeOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTheme(opt.value)}
                      className={`rounded-nkc border px-4 py-2 text-xs ${
                        theme === opt.value
                          ? "border-nkc-accent bg-nkc-panel text-nkc-text"
                          : "border-nkc-border text-nkc-muted hover:bg-nkc-panel"
                      }`}
                    >
                      {tl(opt.label)}
                    </button>
                  ))}
                </div>
                <div className="mt-4 text-xs font-semibold text-nkc-text">
                  {t("언어", "Language")}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setLanguage("ko")}
                    className={`rounded-nkc border px-3 py-2 text-xs ${
                      language === "ko"
                        ? "border-nkc-accent bg-nkc-panel text-nkc-text"
                        : "border-nkc-border text-nkc-muted hover:bg-nkc-panel"
                    }`}
                  >
                    {t("한국어", "Korean")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLanguage("en")}
                    className={`rounded-nkc border px-3 py-2 text-xs ${
                      language === "en"
                        ? "border-nkc-accent bg-nkc-panel text-nkc-text"
                        : "border-nkc-border text-nkc-muted hover:bg-nkc-panel"
                    }`}
                  >
                    English
                  </button>
                </div>
              </section>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onSaveProfile({ displayName, status, theme });
                    setSaveMessage(t("저장되었습니다.", "Saved."));
                    setView("main");
                  }}
                  className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
                >
                  {t("저장", "Save")}
                </button>
              </div>

              {saveMessage ? (
                <div className="text-right text-xs text-nkc-muted">{saveMessage}</div>
              ) : null}
            </div>
          )}

          {/* NETWORK */}
          {view === "network" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("네트워크", "Network"))}

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm font-semibold text-nkc-text">
                  {t("연결 방식", "Connection mode")}
                </div>
                <div className="mt-3 grid gap-2">
                  {modeOptions.map((opt) => (
                    <label
                      key={opt.value}
                      className="flex items-start gap-3 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                    >
                      <input
                        type="radio"
                        name="network-mode"
                        className="mt-1"
                        checked={netConfig.mode === opt.value}
                        onChange={() => void handleModeChange(opt.value)}
                        data-testid={`network-mode-${opt.value}`}
                      />
                      <div>
                        <div className="text-sm font-medium text-nkc-text">
                          {tl(opt.label)}
                        </div>
                        <div className="text-xs text-nkc-muted">
                          {opt.value === "directP2P"
                            ? t("프록시 없이 직접 연결", "Direct connection without proxy")
                            : opt.value === "onionRouter"
                              ? t("외부 Onion 경로(Tor/Lokinet)", "External Onion route (Tor/Lokinet)")
                              : t("내장 Onion 경로(N hops)", "Built-in Onion route (N hops)")}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-nkc-muted">
                  <span
                    className="rounded-full border border-nkc-border bg-nkc-panel px-2 py-1"
                    data-testid="effective-mode-label"
                  >
                    {routeInfo.pathLabel}
                  </span>
                  <span>{routeInfo.description}</span>
                </div>
                <div className="mt-3 text-xs text-nkc-muted">{connectionDescription}</div>
                {netConfig.mode === "selfOnion" ? (
                  <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-nkc-text">
                          {t("Hop 설정", "Hop settings")}
                        </div>
                        <div className="text-xs text-nkc-muted">
                          hops: {selfOnionHopConnected}/{selfOnionHopTarget} · {selfOnionRouteLabel}
                        </div>
                      </div>
                      <select
                        value={selfOnionHopTarget}
                        onChange={(e) => setSelfOnionMinRelays(Number(e.target.value))}
                        className="rounded-nkc border border-nkc-border bg-nkc-panel px-2 py-1 text-xs text-nkc-text"
                      >
                        <option value={3}>3 hops</option>
                        <option value={4}>4 hops</option>
                      </select>
                    </div>
                  </div>
                ) : null}
                {netConfig.mode === "directP2P" ? (
                  <div
                    className="mt-3 rounded-nkc border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
                    data-testid="direct-p2p-warning"
                  >
                    {t(
                      "Direct P2P는 상대에게 IP가 노출될 수 있습니다. 위험을 이해하는 경우에만 사용하세요.",
                      "Direct P2P exposes your IP to the peer. Enable only if you understand the risk."
                    )}
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
                    <div className="text-sm font-medium text-nkc-text">
                      {t("프록시 URL", "Proxy URL")}
                    </div>
                    <div className="mt-2">
                      <input
                        value={proxyUrlDraft}
                        onChange={(e) => handleProxyUrlChange(e.target.value)}
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

                  <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-semibold text-nkc-text">
                        {t("Onion 네트워크", "Onion network")}
                      </div>
                      <div className="text-right text-xs text-nkc-muted">
                        <div>
                          {runtimeLabel}
                          {runtimeSocksLabel}
                        </div>
                        <div>
                          {runtimeStateLabel} · {runtimeNetworkLabel}
                        </div>
                        {runtimeErrorLabel ? (
                          <div className="text-red-300">{runtimeErrorLabel}</div>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4">
                      <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-4 py-3">
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-sm font-medium text-nkc-text">
                            <input
                              type="radio"
                              name="onion-network"
                              checked={onionNetworkDraft === "tor"}
                              onChange={() => setOnionNetworkDraft("tor")}
                            />
                            Tor
                          </label>
                          <div className="text-xs text-nkc-muted">
                            {buildComponentLabel(netConfig.tor)}
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-nkc-muted">
                          {t("SOCKS 기반 · 앱 트래픽만", "SOCKS-based · app traffic only")}
                        </div>
                        {torUpdateStatus ? (
                          <div className="mt-2 max-w-full break-words text-xs text-nkc-muted">
                            {torUpdateStatus}
                          </div>
                        ) : null}
                        {netConfig.tor.detail ? (
                          <div className="mt-2 max-h-24 max-w-full overflow-auto overflow-x-hidden whitespace-pre-wrap break-all text-[11px] text-nkc-muted">
                            {netConfig.tor.detail}
                          </div>
                        ) : null}
                        {torErrorLabel ? (
                          <div className="mt-2 max-w-full break-words text-xs text-red-300">
                            {torErrorLabel}
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!netConfig.tor.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleInstall("tor")}
                              disabled={torInstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {torInstallBusy
                                ? t("처리 중...", "Working...")
                                : t("Tor 다운로드/설치", "Download/Install Tor")}
                            </button>
                          ) : (
                            <>
                              {netConfig.tor.installed &&
                              !(runtime?.network === "tor" && runtime?.status === "running") ? (
                                <button
                                  type="button"
                                  onClick={() => void handleConnectOnion("tor")}
                                  disabled={torInstallBusy || !isComponentReady(netConfig.tor)}
                                  className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                                >
                                  {t("연결", "Connect")}
                                </button>
                              ) : null}
                              {runtime?.network === "tor" && runtime?.status === "running" ? (
                                <button
                                  type="button"
                                  onClick={() => void handleDisconnectOnion("tor")}
                                  className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
                                >
                                  {t("연결 해제", "Disconnect")}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleCheckUpdates()}
                                disabled={torCheckBusy}
                                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                              >
                                {torCheckBusy
                                  ? t("처리 중...", "Working...")
                                  : t("업데이트 확인", "Check updates")}
                              </button>
                              {torUpdateAvailable ? (
                                <button
                                  type="button"
                                  onClick={() => void handleApplyUpdate("tor")}
                                  disabled={torApplyBusy}
                                  className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                                >
                                  {torApplyBusy
                                    ? t("처리 중...", "Working...")
                                    : t("업데이트 적용", "Apply update")}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleUninstall("tor")}
                                disabled={torUninstallBusy}
                                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                              >
                                {torUninstallBusy
                                  ? t("처리 중...", "Working...")
                                  : t("제거", "Uninstall")}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="rounded-nkc border border-nkc-border bg-nkc-panel px-4 py-3">
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-sm font-medium text-nkc-text">
                            <input
                              type="radio"
                              name="onion-network"
                              checked={onionNetworkDraft === "lokinet"}
                              onChange={() => setOnionNetworkDraft("lokinet")}
                            />
                            Lokinet{" "}
                            <span className="text-xs text-nkc-muted">
                              {t("⚠ 고급", "⚠ Advanced")}
                            </span>
                          </label>
                          <div className="text-xs text-nkc-muted">
                            {buildComponentLabel(netConfig.lokinet)}
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-nkc-muted">
                          {t("Exit/VPN 기반 · 앱 전용 라우팅", "Exit/VPN based · app-only routing")}
                        </div>
                        {lokinetUpdateStatus ? (
                          <div className="mt-2 max-w-full break-words text-xs text-nkc-muted">
                            {lokinetUpdateStatus}
                          </div>
                        ) : null}
                        {netConfig.lokinet.detail ? (
                          <div className="mt-2 max-h-24 max-w-full overflow-auto overflow-x-hidden whitespace-pre-wrap break-all text-[11px] text-nkc-muted">
                            {netConfig.lokinet.detail}
                          </div>
                        ) : null}
                        {lokinetErrorLabel ? (
                          <div className="mt-2 max-w-full break-words text-xs text-red-300">
                            {lokinetErrorLabel}
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!netConfig.lokinet.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleInstall("lokinet")}
                              disabled={lokinetInstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {lokinetInstallBusy
                                ? t("처리 중...", "Working...")
                                : t(
                                    "Lokinet 설치(관리자 권한 필요)",
                                    "Install Lokinet (admin required)"
                                  )}
                            </button>
                          ) : null}
                          {netConfig.lokinet.installed &&
                          !(runtime?.network === "lokinet" && runtime?.status === "running") ? (
                            <button
                              type="button"
                              onClick={() => void handleConnectOnion("lokinet")}
                              disabled={lokinetInstallBusy || !isComponentReady(netConfig.lokinet)}
                              className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                            >
                              {t("연결", "Connect")}
                            </button>
                          ) : null}
                          {runtime?.network === "lokinet" && runtime?.status === "running" ? (
                            <button
                              type="button"
                              onClick={() => void handleDisconnectOnion("lokinet")}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              {t("연결 해제", "Disconnect")}
                            </button>
                          ) : null}
                          {lokinetUpdateAvailable ? (
                            <button
                              type="button"
                              onClick={() => void handleApplyUpdate("lokinet")}
                              disabled={lokinetApplyBusy}
                              className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                            >
                              {lokinetApplyBusy
                                ? t("처리 중...", "Working...")
                                : t("업데이트 적용", "Apply update")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={async () => {
                              if (lokinetStatusBusy) return;
                              setLokinetStatusBusy(true);
                              try {
                                await refreshOnionStatus();
                                setSaveMessage(t("Lokinet 상태 확인 완료", "Lokinet status checked"));
                              } catch (error) {
                                console.error("Failed to refresh lokinet status", error);
                                setSaveMessage(t("Lokinet 상태 확인 실패", "Lokinet status check failed"));
                              } finally {
                                setLokinetStatusBusy(false);
                              }
                            }}
                            disabled={lokinetStatusBusy}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                          >
                            {lokinetStatusBusy
                              ? t("처리 중...", "Working...")
                              : t("상태 확인", "Check status")}
                          </button>
                          {netConfig.lokinet.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleUninstall("lokinet")}
                              disabled={lokinetUninstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {lokinetUninstallBusy
                                ? t("처리 중...", "Working...")
                                : t("제거", "Uninstall")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </section>
                </>
              ) : null}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleSaveOnion()}
                  className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={netConfig.mode === "onionRouter" && onionEnabledDraft && !canSaveOnion}
                >
                  {t("저장", "Save")}
                </button>
              </div>

              {saveMessage ? (
                <div className="text-right text-xs text-nkc-muted">{saveMessage}</div>
              ) : null}
            </div>
          )}

          {/* DEVICES */}
          {view === "devices" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("디바이스 / 동기화", "Devices / Sync"))}

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm font-semibold text-nkc-text">
                  {t("이 디바이스", "This device")}
                </div>
                <div className="mt-4 grid gap-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs text-nkc-muted">
                        {t("디바이스 ID", "Device ID")}
                      </div>
                      <div className="mt-1 font-mono text-sm text-nkc-text">
                        {deviceInfo ? deviceInfo.deviceId.slice(0, 12) : "-"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const deviceId = deviceInfo?.deviceId ?? getOrCreateDeviceId();
                        try {
                          if (!navigator.clipboard) {
                            throw new Error("Clipboard not available");
                          }
                          await navigator.clipboard.writeText(deviceId);
                          addToast({
                            message: t(
                              "디바이스 ID를 복사했습니다.",
                              "Device ID copied."
                            ),
                          });
                        } catch (error) {
                          console.error("Failed to copy device id", error);
                          addToast({
                            message: t(
                              "디바이스 ID 복사에 실패했습니다.",
                              "Failed to copy device ID."
                            ),
                          });
                        }
                      }}
                      className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                    >
                      {t("복사", "Copy")}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-xs text-nkc-muted">
                      {t("현재 역할", "Current role")}
                    </div>
                    <span
                      className={`rounded-full border px-2 py-1 text-xs ${
                        deviceInfo?.role === "secondary"
                          ? "border-nkc-border text-nkc-muted"
                          : "border-nkc-accent/40 bg-nkc-panel text-nkc-text"
                      }`}
                    >
                      {deviceInfo?.role === "secondary" ? "Secondary" : "Primary"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-xs text-nkc-muted">
                      {t("역할 에폭", "Role epoch")}
                    </div>
                    <div className="text-xs text-nkc-muted">
                      {deviceInfo?.epoch ?? 0}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setPromoteConfirmOpen(true)}
                    className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
                  >
                    {t("이 디바이스를 Primary로 설정", "Set this device as Primary")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoteConfirmOpen(true)}
                    className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    {t("Secondary로 변경", "Switch to Secondary")}
                  </button>
                </div>
              </section>
            </div>
          )}

          {/* PRIVACY */}
          {view === "privacy" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("보안 / 개인정보", "Security / Privacy"))}

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-nkc-text">
                    {t("보안", "Security")}
                  </h3>
                  <button
                    type="button"
                    onClick={onLock}
                    className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                  >
                    <Lock size={14} />
                    {t("잠그기", "Lock")}
                  </button>
                </div>

                <div className="mt-4 grid gap-3">
                  <label className="flex items-center justify-between text-sm text-nkc-text">
                    <span>{t("PIN 잠금", "PIN lock")}</span>
                    <input
                      type="checkbox"
                      checked={pinEnabled}
                      onChange={(e) => void handleTogglePin(e.target.checked)}
                      disabled={!pinAvailable}
                    />
                  </label>

                  {!pinAvailable ? (
                    <div className="text-xs text-nkc-muted">
                      {t("PIN lock is unavailable on this platform/build.", "PIN lock is unavailable on this platform/build.")}
                    </div>
                  ) : null}

                  {pinEnabled ? (
                    <div className="grid gap-2">
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="\\d*"
                        maxLength={8}
                        value={pinDraft}
                        onChange={(e) => setPinDraft(e.target.value)}
                        placeholder={t("4-8자리", "4-8 digits")}
                        className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                        disabled={!pinAvailable}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSetPin()}
                        className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                        disabled={!pinDraft || !pinAvailable}
                      >
                        {t("PIN 설정", "Set PIN")}
                      </button>
                    </div>
                  ) : null}

                  {pinError ? (
                    <div className="text-xs text-red-300">{pinError}</div>
                  ) : null}

                  <button
                    type="button"
                    onClick={onOpenRecovery}
                    className="flex w-fit items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                  >
                    <KeyRound size={14} />
                    {t("복구 키 관리", "Manage recovery key")}
                  </button>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">
                        {t("읽음 표시", "Read receipts")}
                      </div>
                      <div className="text-xs text-nkc-muted">
                        {t(
                          "상대에게 읽음 상태를 공유합니다.",
                          "Share read status with the other person."
                        )}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={privacyPrefs.readReceipts}
                      onChange={(e) =>
                        void updatePrivacy({ ...privacyPrefs, readReceipts: e.target.checked })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">
                        {t("입력 표시", "Typing indicator")}
                      </div>
                      <div className="text-xs text-nkc-muted">
                        {t(
                          "상대에게 입력 중 상태를 표시합니다.",
                          "Show typing status to the other person."
                        )}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={privacyPrefs.typingIndicator}
                      onChange={(e) =>
                        void updatePrivacy({ ...privacyPrefs, typingIndicator: e.target.checked })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">
                        {t("링크 미리보기", "Link preview")}
                      </div>
                      <div className="text-xs text-nkc-muted">
                        {t("링크 카드 표시", "Show link card")}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={privacyPrefs.linkPreviews}
                      onChange={(e) =>
                        void updatePrivacy({ ...privacyPrefs, linkPreviews: e.target.checked })
                      }
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* FRIENDS */}
          {view === "friends" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("친구 관리", "Friend management"))}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="grid gap-4 text-sm">
                  <div>
                    <div className="text-xs text-nkc-muted">
                      {t("숨김 목록", "Hidden list")}
                    </div>
                    {hiddenFriends.length ? (
                      <div className="mt-2 grid gap-2">
                        {hiddenFriends.map((friend) => (
                          <div
                            key={friend.id}
                            className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                          >
                            <span className="text-nkc-text">{friend.displayName}</span>
                            <button
                              type="button"
                              onClick={() => void onUnhideFriend(friend.id)}
                              className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              {t("복원", "Restore")}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        {t("숨김 친구가 없습니다.", "No hidden friends.")}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-xs text-nkc-muted">
                      {t("차단 목록", "Blocked list")}
                    </div>
                    {blockedFriends.length ? (
                      <div className="mt-2 grid gap-2">
                        {blockedFriends.map((friend) => (
                          <div
                            key={friend.id}
                            className="flex items-center justify-between rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
                          >
                            <span className="text-nkc-text">{friend.displayName}</span>
                            <button
                              type="button"
                              onClick={() => void onUnblockFriend(friend.id)}
                              className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              {t("차단 해제", "Unblock")}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        {t("차단된 친구가 없습니다.", "No blocked friends.")}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* STORAGE */}
          {view === "storage" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("저장소 관리", "Storage management"))}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm font-semibold text-nkc-text">
                  {t("저장소 관리", "Storage management")}
                </div>
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
                    onClick={() => {
                      if (chatWipeBusy) return;
                      setWipeConfirmType("chat");
                      setWipeConfirmOpen(true);
                    }}
                    disabled={chatWipeBusy}
                    className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                  >
                    {chatWipeBusy ? t("처리 중...", "Working...") : t("채팅 내역 초기화", "Reset chat history")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (mediaWipeBusy) return;
                      setWipeConfirmType("media");
                      setWipeConfirmOpen(true);
                    }}
                    disabled={mediaWipeBusy}
                    className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                  >
                    {mediaWipeBusy ? t("처리 중...", "Working...") : t("미디어 초기화", "Reset media")}
                  </button>
                </div>
              </section>
            </div>
          )}

          {/* HELP */}
          {view === "help" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("도움말", "Help"))}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm text-nkc-text">
                  {t("준비중입니다.", "Coming soon.")}
                </div>
                <div className="mt-2 text-xs text-nkc-muted">
                  {t(
                    "도움말 콘텐츠는 추후 업데이트될 예정입니다.",
                    "Help content will be updated later."
                  )}
                </div>
              </section>
            </div>
          )}

          {/* DANGER */}
          {view === "danger" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader(t("위험 구역", "Danger zone"))}
              <section className="rounded-nkc border border-red-500/50 bg-red-500/20 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-red-100">
                      {t("위험 구역", "Danger zone")}
                    </h3>
                    <p className="mt-1 text-xs text-red-100/80">
                      {t(
                        "로그아웃 또는 데이터 초기화를 진행합니다.",
                        "Proceed with logout or data reset."
                      )}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onLogout}
                    className="rounded-nkc border border-red-400/60 px-3 py-2 text-xs text-red-100 hover:bg-red-500/20"
                  >
                    {t("로그아웃", "Logout")}
                  </button>
                  <button
                    type="button"
                    onClick={onWipe}
                    className="rounded-nkc border border-red-300 bg-red-500/30 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/40"
                  >
                    {t("데이터 삭제", "Delete data")}
                  </button>
                </div>
              </section>
            </div>
          )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={promoteConfirmOpen}
        title={t("Primary로 설정", "Set as Primary")}
        message={t(
          "서버가 없기 때문에 다른 디바이스도 Primary일 수 있습니다. 나중에 두 디바이스가 다시 연결되면 역할을 정리해야 합니다. 계속할까요?",
          "Without a server, other devices might also be Primary. When devices reconnect, roles must be reconciled. Continue?"
        )}
        onClose={() => setPromoteConfirmOpen(false)}
        onConfirm={() => {
          const info = promoteToPrimary();
          setDeviceInfo(info);
          addToast({
            message: t(
              "이 디바이스가 Primary로 설정되었습니다.",
              "This device is now Primary."
            ),
          });
        }}
      />
      <ConfirmDialog
        open={demoteConfirmOpen}
        title={t("Secondary로 변경", "Switch to Secondary")}
        message={t(
          "이 디바이스를 Secondary로 전환합니다. 계속할까요?",
          "This device will switch to Secondary. Continue?"
        )}
        onClose={() => setDemoteConfirmOpen(false)}
        onConfirm={() => {
          const info = demoteToSecondary();
          setDeviceInfo(info);
          addToast({
            message: t(
              "이 디바이스가 Secondary로 설정되었습니다.",
              "This device is now Secondary."
            ),
          });
        }}
      />
      <ConfirmDialog
        open={wipeConfirmOpen}
        title={
          wipeConfirmType === "media"
            ? t("미디어 삭제 경고", "Media deletion warning")
            : t("채팅 삭제 경고", "Chat deletion warning")
        }
        message={
          wipeConfirmType === "media"
            ? t(
                "모든 미디어(첨부파일/아바타)를 초기화합니다. 복구할 수 없으며, 잔여 데이터 복구를 어렵게 하기 위해 암호화로 덮어쓴 뒤 제거합니다. 계속할까요?",
                "This deletes all media (attachments/avatars). It cannot be undone; remaining data is overwritten with encryption before removal. Continue?"
              )
            : t(
                "채팅 내역을 초기화합니다. 복구할 수 없으며, 잔여 데이터 복구를 어렵게 하기 위해 암호화로 덮어쓴 뒤 제거합니다. 계속할까요?",
                "This resets chat history. It cannot be undone; remaining data is overwritten with encryption before removal. Continue?"
              )
        }
        onClose={() => {
          setWipeConfirmOpen(false);
          setWipeConfirmType(null);
        }}
        onConfirm={async () => {
          if (!wipeConfirmType) return;
          if (wipeConfirmType === "chat") {
            if (chatWipeBusy) return;
            setChatWipeBusy(true);
            try {
              await clearChatHistory();
              await refreshAppData();
              const usage = await getVaultUsage();
              setVaultUsageBytes(usage.bytes);
              setSaveMessage(t("채팅 내역이 초기화되었습니다.", "Chat history reset."));
            } catch (error) {
              console.error("Failed to clear chat history", error);
              setSaveMessage(t("채팅 내역 초기화 실패", "Chat reset failed"));
            } finally {
              setChatWipeBusy(false);
            }
            return;
          }

          if (mediaWipeBusy) return;
          setMediaWipeBusy(true);
          try {
            await deleteAllMedia();
            await refreshAppData();
            const usage = await getVaultUsage();
            setVaultUsageBytes(usage.bytes);
            setSaveMessage(t("미디어가 초기화되었습니다.", "Media reset."));
          } catch (error) {
            console.error("Failed to delete media", error);
            setSaveMessage(t("미디어 초기화 실패", "Media reset failed"));
            } finally {
              setMediaWipeBusy(false);
            }
          }}
        />
      <ConfirmDialog
        open={directP2PConfirmOpen}
        title={t("Direct P2P 위험 안내", "Direct P2P risk warning")}
        message={t(
          "Direct P2P는 상대에게 IP가 노출될 수 있습니다. 위험을 이해하는 경우에만 활성화하세요.",
          "Direct P2P exposes your IP to the peer. Enable only if you understand the risk."
        )}
        onConfirm={() => {
          void handleConfirmDirectP2P();
        }}
        onClose={() => {
          setDirectP2PConfirmOpen(false);
          setPendingMode(null);
        }}
        confirmTestId="direct-p2p-confirm"
        dialogTestId="direct-p2p-confirm-dialog"
      />
      </>
    );
  }
