import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, KeyRound, Lock } from "lucide-react";
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
  getPrivacyPrefs,
  setPrivacyPrefs,
} from "../security/preferences";
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
import { getConnectionStatus, onConnectionStatus } from "../net/connectionStatus";
import Avatar from "./Avatar";

const themeOptions = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
] as const;

const modeOptions: { value: NetworkMode; label: string }[] = [
  { value: "directP2P", label: "Direct P2P" },
  { value: "onionRouter", label: "릴레이 / Onion" },
  { value: "selfOnion", label: "내부 Onion" },
];

type SettingsView =
  | "main"
  | "privacy"
  | "theme"
  | "friends"
  | "danger"
  | "network"
  | "help"
  | "storage";

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

  // network
  const [onionEnabledDraft, setOnionEnabledDraft] = useState(netConfig.onionEnabled);
  const [onionNetworkDraft, setOnionNetworkDraft] = useState(netConfig.onionSelectedNetwork);
  const [onionStatus, setOnionStatus] = useState<OnionStatus | null>(null);
  const [torInstallBusy, setTorInstallBusy] = useState(false);
  const [torCheckBusy, setTorCheckBusy] = useState(false);
  const [torApplyBusy, setTorApplyBusy] = useState(false);
  const [torUninstallBusy, setTorUninstallBusy] = useState(false);
  const [lokinetInstallBusy, setLokinetInstallBusy] = useState(false);
  const [lokinetStatusBusy, setLokinetStatusBusy] = useState(false);
  const [lokinetApplyBusy, setLokinetApplyBusy] = useState(false);
  const [lokinetUninstallBusy, setLokinetUninstallBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(getConnectionStatus());
  const [mediaWipeBusy, setMediaWipeBusy] = useState(false);
  const [chatWipeBusy, setChatWipeBusy] = useState(false);
  const [vaultUsageBytes, setVaultUsageBytes] = useState(0);
  const [vaultUsageMaxBytes, setVaultUsageMaxBytes] = useState(50 * 1024 * 1024);

  const setData = useAppStore((state) => state.setData);
  const setSelectedConv = useAppStore((state) => state.setSelectedConv);
  const userProfileState = useAppStore((state) => state.userProfile);

  // misc
  const [saveMessage, setSaveMessage] = useState("");

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
    getPrivacyPrefs()
      .then(setPrivacyPrefsState)
      .catch((e) => console.error("Failed to load privacy prefs", e));
  }, [open, netConfig.onionEnabled, netConfig.onionSelectedNetwork]);

  useEffect(() => {
    const unsubscribe = onConnectionStatus(setConnectionStatus);
    return () => unsubscribe();
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
      setSaveMessage("업데이트 확인 완료");
    } catch (error) {
      console.error("Failed to check onion updates", error);
      setSaveMessage("업데이트 확인 실패");
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
      setSaveMessage("업데이트 적용 완료");
    } catch (error) {
      console.error("Failed to apply onion update", error);
      setSaveMessage("업데이트 적용 실패");
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
      setSaveMessage(network === "tor" ? "Tor 설치 완료" : "Lokinet 설치 완료");
    } catch (error) {
      console.error("Failed to install onion component", error);
      setSaveMessage(network === "tor" ? "Tor 설치 실패" : "Lokinet 설치 실패");
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
      setSaveMessage(network === "tor" ? "Tor 제거 완료" : "Lokinet 제거 완료");
    } catch (error) {
      console.error("Failed to uninstall onion component", error);
      setSaveMessage(network === "tor" ? "Tor 제거 실패" : "Lokinet 제거 실패");
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
      setSaveMessage("저장됨");
    } catch (error) {
      console.error("Failed to save onion settings", error);
      setSaveMessage("저장에 실패했습니다.");
    }
  };

  const handleStopOnion = async () => {
    try {
      await setOnionMode(false, onionNetworkDraft);
      setSaveMessage("연결 해제됨");
      await refreshOnionStatus();
    } catch (error) {
      console.error("Failed to stop onion runtime", error);
      setSaveMessage("연결 해제 실패");
    }
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
        뒤로
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
      setSaveMessage("저장되었습니다.");
    } catch (e) {
      console.error("Failed to save profile", e);
      setSaveMessage("저장에 실패했습니다.");
    }
  };

  const handleSetPin = async () => {
    setPinError("");
    const value = pinDraft.trim();
    if (value.length < 4) {
      setPinError("PIN은 최소 4자리 이상이어야 합니다.");
      return;
    }
    const result = await onSetPin(value);
    if (!result.ok) {
      setPinError(result.error || "PIN 설정에 실패했습니다.");
      return;
    }
    setPinDraft("");
    setSaveMessage("PIN이 설정되었습니다.");
  };

  const handleTogglePin = async (next: boolean) => {
    setPinError("");
    if (!next) {
      await onDisablePin();
      setPinDraft("");
      setSaveMessage("PIN이 해제되었습니다.");
    }
  };

  const routeInfo = getRouteInfo(netConfig.mode, netConfig);
  const runtime = onionStatus?.runtime;
  const runtimeLabel = runtime
    ? runtime.status === "running"
      ? "경로: 연결됨"
      : runtime.status === "starting"
        ? "경로: 시작 중"
        : runtime.status === "failed"
          ? "경로: 실패"
          : "경로: 대기"
    : "경로: 확인 필요";
  const runtimeStateLabel = runtime
    ? runtime.status === "running"
      ? "상태: 실행 중"
      : runtime.status === "starting"
        ? "상태: 시작 중"
        : runtime.status === "failed"
          ? "상태: 실패"
          : "상태: 대기"
    : "상태: 확인 필요";
  const runtimeNetworkLabel = runtime?.network ? `네트워크: ${runtime.network}` : "네트워크: -";
  const runtimeSocksLabel =
    runtime && runtime.status === "running" && runtime.network === "tor" && runtime.socksPort
      ? ` · SOCKS 127.0.0.1:${runtime.socksPort}`
      : "";
  const runtimeErrorLabel = runtime?.error ? `실패: ${runtime.error}` : "";

  const formatOnionError = (value?: string) => {
    if (!value) return null;
    if (value === "PINNED_HASH_MISSING") return "실패: 검증 데이터 없음";
    const trimmed = value.split("| details=")[0].trim();
    const match = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    const code = match?.[1] ?? "";
    const message = match?.[2] ?? trimmed;
    const label =
      code === "DOWNLOAD_FAILED"
        ? "다운로드 실패"
        : code === "HASH_MISMATCH"
          ? "검증 실패"
          : code === "EXTRACT_FAILED"
            ? "압축 해제 실패"
            : code === "PERMISSION_DENIED"
              ? "권한 부족"
              : code === "BINARY_MISSING"
                ? "실행 파일 없음"
                : code === "FS_ERROR"
                  ? "파일 시스템 오류"
                  : code === "PINNED_HASH_MISSING"
                    ? "검증 데이터 없음"
                    : code === "UNKNOWN_ERROR"
                      ? "알 수 없는 오류"
                      : null;
    const shortMessage = label ? `${label}${message ? ` · ${message}` : ""}` : message;
    return `실패: ${shortMessage}`;
  };

  const selfOnionHopTarget = netConfig.selfOnionMinRelays;
  const selfOnionHopConnected =
    connectionStatus.transport === "selfOnion" && connectionStatus.state === "connected"
      ? selfOnionHopTarget
      : 0;
  const selfOnionRouteLabel =
    connectionStatus.transport === "selfOnion"
      ? connectionStatus.state === "connected"
        ? "경로: 연결됨"
        : connectionStatus.state === "connecting"
          ? "경로: 연결 중"
          : connectionStatus.state === "failed"
            ? "경로: 실패"
            : "경로: 대기"
      : "경로: 대기";

  const buildComponentLabel = (state: typeof netConfig.tor) => {
    if (state.status === "downloading") return "다운로드 중";
    if (state.status === "installing") return "설치 중";
    if (state.status === "failed") return "실패";
    if (state.installed) return "설치됨";
    return "미설치";
  };

  const torUpdateAvailable = Boolean(
    netConfig.tor.latest && netConfig.tor.latest !== netConfig.tor.version
  );
  const lokinetUpdateAvailable = Boolean(
    netConfig.lokinet.latest && netConfig.lokinet.latest !== netConfig.lokinet.version
  );
  const torUpdateStatus = netConfig.lastUpdateCheckAtMs
    ? netConfig.tor.error === "PINNED_HASH_MISSING"
      ? "검증 데이터 없음"
      : torUpdateAvailable
        ? `업데이트 가능: ${netConfig.tor.latest}`
        : "최신 상태"
    : "";
  const lokinetUpdateStatus = netConfig.lastUpdateCheckAtMs
    ? netConfig.lokinet.error === "PINNED_HASH_MISSING"
      ? "검증 데이터 없음"
      : lokinetUpdateAvailable
        ? `업데이트 가능: ${netConfig.lokinet.latest}`
        : "최신 상태"
    : "";
  const torErrorLabel = formatOnionError(netConfig.tor.error);
  const lokinetErrorLabel = formatOnionError(netConfig.lokinet.error);

  const canSaveOnion =
    !onionEnabledDraft ||
    (onionNetworkDraft === "tor" ? netConfig.tor.installed : netConfig.lokinet.installed);

  const connectionDescription =
    netConfig.mode === "onionRouter"
      ? "외부 Onion: Tor 또는 Lokinet 경로를 사용합니다."
      : netConfig.mode === "directP2P"
        ? "Direct P2P: 프록시 없이 직접 연결을 시도합니다."
        : "내부 Onion: 앱 내부 hop 경로를 사용합니다.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 h-[80vh] w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
          <Dialog.Title className="text-lg font-semibold text-nkc-text">
            설정
          </Dialog.Title>

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
                          {status ? status : "상태 메시지가 없습니다."}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={startEdit}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                          >
                            편집
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="text-sm text-nkc-text">
                          표시 이름
                          <input
                            value={displayNameDraft}
                            onChange={(e) => setDisplayNameDraft(e.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                          />
                        </label>
                        <label className="mt-3 block text-sm text-nkc-text">
                          상태 메시지
                          <input
                            value={statusDraft}
                            onChange={(e) => setStatusDraft(e.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                          />
                        </label>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <label className="cursor-pointer rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel">
                            사진 업로드
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                try {
                                  await onUploadPhoto(file);
                                  setSaveMessage("사진이 업로드되었습니다.");
                                } catch (err) {
                                  console.error("Upload failed", err);
                                  setSaveMessage("사진 업로드에 실패했습니다.");
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
                            저장
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                          >
                            취소
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
                    친구 관리
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("network")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    네트워크 설정
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("privacy")}
                    className="flex w-full items-center gap-3 border-b border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    보안 / 개인정보
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("theme")}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    테마
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("storage")}
                    className="flex w-full items-center gap-3 border-t border-nkc-border px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel"
                  >
                    저장소 관리
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
                    도움말
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("danger")}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-red-200 hover:bg-nkc-panel"
                  >
                    위험 구역
                  </button>
                </div>
              </section>

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                    닫기
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
              {renderBackHeader("테마")}
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
                      {opt.label}
                    </button>
                  ))}
                </div>
              </section>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onSaveProfile({ displayName, status, theme });
                    setSaveMessage("저장되었습니다.");
                    setView("main");
                  }}
                  className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
                >
                  저장
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
              {renderBackHeader("네트워크")}

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm font-semibold text-nkc-text">연결 방식</div>
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
                        onChange={() => setMode(opt.value)}
                      />
                      <div>
                        <div className="text-sm font-medium text-nkc-text">{opt.label}</div>
                        <div className="text-xs text-nkc-muted">
                          {opt.value === "directP2P"
                            ? "프록시 없이 직접 연결"
                            : opt.value === "onionRouter"
                              ? "외부 Onion 경로(Tor/Lokinet)"
                              : "내장 Onion 경로(N hops)"}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-nkc-muted">
                  <span className="rounded-full border border-nkc-border bg-nkc-panel px-2 py-1">
                    {routeInfo.pathLabel}
                  </span>
                  <span>{routeInfo.description}</span>
                </div>
                <div className="mt-3 text-xs text-nkc-muted">{connectionDescription}</div>
                {netConfig.mode === "selfOnion" ? (
                  <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-nkc-text">Hop 설정</div>
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
                  <div className="mt-3 rounded-nkc border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                    Direct P2P는 상대에게 IP가 노출될 수 있습니다.
                  </div>
                ) : null}
              </section>

              {netConfig.mode === "onionRouter" ? (
                <>
                  <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium text-nkc-text">IP 보호 모드 사용</div>
                        <div className="text-xs text-nkc-muted">
                          direct P2P를 차단하고, 실패 시 네트워크를 중지합니다.
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
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-semibold text-nkc-text">Onion 네트워크</div>
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
                        <div className="mt-2 text-xs text-nkc-muted">SOCKS 기반 · 앱 트래픽만</div>
                        {torUpdateStatus ? (
                          <div className="mt-2 text-xs text-nkc-muted">{torUpdateStatus}</div>
                        ) : null}
                        {torErrorLabel ? (
                          <div className="mt-2 text-xs text-red-300">{torErrorLabel}</div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!netConfig.tor.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleInstall("tor")}
                              disabled={torInstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {torInstallBusy ? "처리 중..." : "Tor 다운로드/설치"}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleCheckUpdates()}
                                disabled={torCheckBusy}
                                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                              >
                                {torCheckBusy ? "처리 중..." : "업데이트 확인"}
                              </button>
                              {torUpdateAvailable ? (
                                <button
                                  type="button"
                                  onClick={() => void handleApplyUpdate("tor")}
                                  disabled={torApplyBusy}
                                  className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                                >
                                  {torApplyBusy ? "처리 중..." : "업데이트 적용"}
                                </button>
                              ) : null}
                              {runtime?.network === "tor" && runtime?.status === "running" ? (
                                <button
                                  type="button"
                                  onClick={() => void handleStopOnion()}
                                  className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
                                >
                                  연결 해제
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleUninstall("tor")}
                                disabled={torUninstallBusy}
                                className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                              >
                                {torUninstallBusy ? "처리 중..." : "제거"}
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
                            Lokinet <span className="text-xs text-nkc-muted">⚠ 고급</span>
                          </label>
                          <div className="text-xs text-nkc-muted">
                            {buildComponentLabel(netConfig.lokinet)}
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-nkc-muted">
                          Exit/VPN 기반 · 앱 전용 라우팅
                        </div>
                        {lokinetUpdateStatus ? (
                          <div className="mt-2 text-xs text-nkc-muted">{lokinetUpdateStatus}</div>
                        ) : null}
                        {lokinetErrorLabel ? (
                          <div className="mt-2 text-xs text-red-300">{lokinetErrorLabel}</div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!netConfig.lokinet.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleInstall("lokinet")}
                              disabled={lokinetInstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {lokinetInstallBusy ? "처리 중..." : "Lokinet 설치(관리자 권한 필요)"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={async () => {
                              if (lokinetStatusBusy) return;
                              setLokinetStatusBusy(true);
                              try {
                                await refreshOnionStatus();
                                setSaveMessage("Lokinet 상태 확인 완료");
                              } catch (error) {
                                console.error("Failed to refresh lokinet status", error);
                                setSaveMessage("Lokinet 상태 확인 실패");
                              } finally {
                                setLokinetStatusBusy(false);
                              }
                            }}
                            disabled={lokinetStatusBusy}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                          >
                            {lokinetStatusBusy ? "처리 중..." : "상태 확인"}
                          </button>
                          {runtime?.network === "lokinet" && runtime?.status === "running" ? (
                            <button
                              type="button"
                              onClick={() => void handleStopOnion()}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              연결 해제
                            </button>
                          ) : null}
                          {lokinetUpdateAvailable ? (
                            <button
                              type="button"
                              onClick={() => void handleApplyUpdate("lokinet")}
                              disabled={lokinetApplyBusy}
                              className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                            >
                              {lokinetApplyBusy ? "처리 중..." : "업데이트 적용"}
                            </button>
                          ) : null}
                          {netConfig.lokinet.installed ? (
                            <button
                              type="button"
                              onClick={() => void handleUninstall("lokinet")}
                              disabled={lokinetUninstallBusy}
                              className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                            >
                              {lokinetUninstallBusy ? "처리 중..." : "제거"}
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
                  저장
                </button>
              </div>

              {saveMessage ? (
                <div className="text-right text-xs text-nkc-muted">{saveMessage}</div>
              ) : null}
            </div>
          )}

          {/* PRIVACY */}
          {view === "privacy" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader("보안 / 개인정보")}

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-nkc-text">보안</h3>
                  <button
                    type="button"
                    onClick={onLock}
                    className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                  >
                    <Lock size={14} />
                    잠그기
                  </button>
                </div>

                <div className="mt-4 grid gap-3">
                  <label className="flex items-center justify-between text-sm text-nkc-text">
                    <span>PIN 잠금</span>
                    <input
                      type="checkbox"
                      checked={pinEnabled}
                      onChange={(e) => void handleTogglePin(e.target.checked)}
                    />
                  </label>

                  {pinEnabled ? (
                    <div className="grid gap-2">
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="\\d*"
                        maxLength={8}
                        value={pinDraft}
                        onChange={(e) => setPinDraft(e.target.value)}
                        placeholder="4-8자리"
                        className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm text-nkc-text"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSetPin()}
                        className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:opacity-50"
                        disabled={!pinDraft}
                      >
                        PIN 설정
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
                    복구 키 관리
                  </button>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">읽음 표시</div>
                      <div className="text-xs text-nkc-muted">
                        상대에게 읽음 상태를 공유합니다.
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
                      <div className="text-sm font-medium text-nkc-text">입력 표시</div>
                      <div className="text-xs text-nkc-muted">
                        상대에게 입력 중 상태를 표시합니다.
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
                      <div className="text-sm font-medium text-nkc-text">링크 미리보기</div>
                      <div className="text-xs text-nkc-muted">링크 카드 표시</div>
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
              {renderBackHeader("친구 관리")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="grid gap-4 text-sm">
                  <div>
                    <div className="text-xs text-nkc-muted">숨김 목록</div>
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
                              복원
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        숨김 친구가 없습니다.
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-xs text-nkc-muted">차단 목록</div>
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
                              차단 해제
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        차단된 친구가 없습니다.
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
              {renderBackHeader("저장소 관리")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm font-semibold text-nkc-text">저장소 관리</div>
                <div className="mt-2 text-xs text-nkc-muted">
                  삭제 후에는 복구할 수 없습니다. 삭제 시 데이터를 암호화로 덮어씌운 뒤
                  제거합니다.
                </div>
                <div className="mt-2 text-xs text-nkc-muted">
                  다른 기기에는 적용되지 않으며, 각 기기에서 별도로 초기화해야 합니다.
                </div>
                <div className="mt-4 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2">
                  <div className="flex items-center justify-between text-xs text-nkc-muted">
                    <span>저장소 사용량(추정)</span>
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
                    onClick={async () => {
                      if (mediaWipeBusy) return;
                      const ok = window.confirm(
                        "미디어(사진/첨부파일)를 모두 삭제합니다. 계속할까요?"
                      );
                      if (!ok) return;
                      setMediaWipeBusy(true);
                      try {
                        await deleteAllMedia();
                        await refreshAppData();
                        const usage = await getVaultUsage();
                        setVaultUsageBytes(usage.bytes);
                        setSaveMessage("미디어가 삭제되었습니다.");
                      } catch (error) {
                        console.error("Failed to delete media", error);
                        setSaveMessage("미디어 삭제 실패");
                      } finally {
                        setMediaWipeBusy(false);
                      }
                    }}
                    disabled={mediaWipeBusy}
                    className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                  >
                    {mediaWipeBusy ? "처리 중..." : "미디어 전부 삭제"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (chatWipeBusy) return;
                      const ok = window.confirm(
                        "채팅 내역을 초기화합니다. 복구할 수 없습니다. 계속할까요?"
                      );
                      if (!ok) return;
                      setChatWipeBusy(true);
                      try {
                        await clearChatHistory();
                        await refreshAppData();
                        const usage = await getVaultUsage();
                        setVaultUsageBytes(usage.bytes);
                        setSaveMessage("채팅 내역이 초기화되었습니다.");
                      } catch (error) {
                        console.error("Failed to clear chat history", error);
                        setSaveMessage("채팅 내역 초기화 실패");
                      } finally {
                        setChatWipeBusy(false);
                      }
                    }}
                    disabled={chatWipeBusy}
                    className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                  >
                    {chatWipeBusy ? "처리 중..." : "채팅 내역 초기화"}
                  </button>
                </div>
              </section>
            </div>
          )}

          {/* HELP */}
          {view === "help" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader("도움말")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="text-sm text-nkc-text">준비중입니다.</div>
                <div className="mt-2 text-xs text-nkc-muted">
                  도움말 콘텐츠는 추후 업데이트될 예정입니다.
                </div>
              </section>
            </div>
          )}

          {/* DANGER */}
          {view === "danger" && (
            <div className="mt-6 grid gap-6">
              {renderBackHeader("위험 구역")}
              <section className="rounded-nkc border border-red-500/50 bg-red-500/20 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-red-100">위험 구역</h3>
                    <p className="mt-1 text-xs text-red-100/80">
                      로그아웃 또는 데이터 초기화를 진행합니다.
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onLogout}
                    className="rounded-nkc border border-red-400/60 px-3 py-2 text-xs text-red-100 hover:bg-red-500/20"
                  >
                    로그아웃
                  </button>
                  <button
                    type="button"
                    onClick={onWipe}
                    className="rounded-nkc border border-red-300 bg-red-500/30 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/40"
                  >
                    데이터 삭제
                  </button>
                </div>
              </section>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
