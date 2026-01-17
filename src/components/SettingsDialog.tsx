import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  Globe,
  KeyRound,
  Lock,
  Palette,
  ShieldAlert,
  Users,
} from "lucide-react";
import type { UserProfile } from "../db/repo";
import { defaultPrivacyPrefs, getPrivacyPrefs, setPrivacyPrefs } from "../security/preferences";
import Avatar from "./Avatar";
import { useNetConfigStore } from "../net/netConfigStore";
import { applyProxyConfig, checkProxyHealth } from "../net/proxyControl";

const themeOptions = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
] as const;

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

type SettingsView = "main" | "privacy" | "theme" | "friends" | "danger" | "network";

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
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState(user.status);
  const [theme, setTheme] = useState<"dark" | "light">(user.theme);
  const [pinDraft, setPinDraft] = useState("");
  const [pinPending, setPinPending] = useState(false);
  const [pinError, setPinError] = useState("");
  const [privacyPrefs, setPrivacyPrefsState] = useState(defaultPrivacyPrefs);
  const [saveMessage, setSaveMessage] = useState("");
  const [view, setView] = useState<SettingsView>("main");
  const [profileEditing, setProfileEditing] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(user.displayName);
  const [statusDraft, setStatusDraft] = useState(user.status);
  const netConfig = useNetConfigStore((state) => state.config);
  const setMode = useNetConfigStore((state) => state.setMode);
  const setProxy = useNetConfigStore((state) => state.setProxy);
  const setRelayOnly = useNetConfigStore((state) => state.setRelayOnly);
  const setDisableLinkPreview = useNetConfigStore((state) => state.setDisableLinkPreview);
  const isOnionRouterMode = netConfig.mode === "onionRouter";
  const isAutoMode = netConfig.mode === "auto";
  const [proxyStatus, setProxyStatus] = useState<"idle" | "ok" | "fail">("idle");
  const proxyStatusLabel =
    proxyStatus === "ok"
      ? "Proxy: 연결됨"
      : proxyStatus === "fail"
        ? "Proxy: 연결 불가"
        : "Proxy: 비활성";

  useEffect(() => {
    setDisplayName(user.displayName);
    setStatus(user.status);
    setTheme(user.theme);
    setDisplayNameDraft(user.displayName);
    setStatusDraft(user.status);
    setProfileEditing(false);
  }, [user]);

  useEffect(() => {
    if (pinEnabled) {
      setPinPending(false);
      setPinDraft("");
      setPinError("");
    }
  }, [pinEnabled]);

  useEffect(() => {
    if (!open) return;
    setView("main");
    getPrivacyPrefs()
      .then(setPrivacyPrefsState)
      .catch((error) => console.error("Failed to load privacy prefs", error));
  }, [open]);

  useEffect(() => {
    if (!saveMessage) return;
    const timer = window.setTimeout(() => setSaveMessage(""), 2000);
    return () => window.clearTimeout(timer);
  }, [saveMessage]);

  useEffect(() => {
    if (!netConfig.disableLinkPreview || !privacyPrefs.linkPreviews) return;
    void updatePrivacy({ ...privacyPrefs, linkPreviews: false });
  }, [netConfig.disableLinkPreview, privacyPrefs]);

  useEffect(() => {
    let cancelled = false;
    const syncProxy = async () => {
      try {
        await applyProxyConfig(netConfig);
        if (netConfig.mode === "onionRouter" && netConfig.onionProxyEnabled) {
          const status = await checkProxyHealth();
          if (!cancelled) {
            setProxyStatus(status.ok ? "ok" : "fail");
          }
        } else if (!cancelled) {
          setProxyStatus("idle");
        }
      } catch (error) {
        if (!cancelled) {
          setProxyStatus("fail");
        }
      }
    };

    void syncProxy();
    return () => {
      cancelled = true;
    };
  }, [
    netConfig.mode,
    netConfig.onionProxyEnabled,
    netConfig.onionProxyUrl,
    netConfig.allowRemoteProxy,
  ]);

  useEffect(() => {
    if (netConfig.mode !== "onionRouter" || !netConfig.onionProxyEnabled) return;
    const timer = window.setInterval(async () => {
      try {
        const status = await checkProxyHealth();
        setProxyStatus(status.ok ? "ok" : "fail");
      } catch (error) {
        setProxyStatus("fail");
      }
    }, 60000);
    return () => window.clearInterval(timer);
  }, [netConfig.mode, netConfig.onionProxyEnabled]);

  const updatePrivacy = async (next: typeof privacyPrefs) => {
    setPrivacyPrefsState(next);
    try {
      await setPrivacyPrefs(next);
    } catch (error) {
      console.error("Failed to save privacy prefs", error);
    }
  };

  const startProfileEdit = () => {
    setDisplayNameDraft(displayName);
    setStatusDraft(status);
    setProfileEditing(true);
  };

  const cancelProfileEdit = () => {
    setDisplayNameDraft(user.displayName);
    setStatusDraft(user.status);
    setProfileEditing(false);
  };

  const saveProfileEdit = async () => {
    try {
      await onSaveProfile({
        displayName: displayNameDraft,
        status: statusDraft,
        theme,
      });
      setDisplayName(displayNameDraft);
      setStatus(statusDraft);
      setProfileEditing(false);
      setSaveMessage("저장했습니다");
    } catch (error) {
      console.error("Failed to save profile", error);
    }
  };

  const settingsMenu = [
    {
      key: "friends",
      label: "친구 관리",
      icon: Users,
      onClick: () => setView("friends"),
    },
    {
      key: "theme",
      label: "테마",
      icon: Palette,
      onClick: () => setView("theme"),
    },
    {
      key: "network",
      label: "네트워크",
      icon: Globe,
      onClick: () => setView("network"),
    },
    {
      key: "privacy",
      label: "개인정보 보호",
      icon: Lock,
      onClick: () => setView("privacy"),
    },
    {
      key: "danger",
      label: "위험 구역",
      icon: ShieldAlert,
      onClick: () => setView("danger"),
    },
  ];

  const renderSubHeader = (title: string) => (
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 h-[80vh] w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-8 shadow-soft">
          <Dialog.Title className="text-lg font-semibold">NKC 설정</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            프로필과 보안 설정은 로컬 금고에 암호화되어 저장됩니다.
          </Dialog.Description>

          {view === "main" ? (
            <div className="mt-6 grid gap-6">
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex items-start gap-4">
                  <Avatar name={user.id} avatarRef={user.avatarRef} size={64} />
                  <div className="min-w-0 flex-1">
                    {!profileEditing ? (
                      <>
                        <div className="truncate text-sm font-semibold text-nkc-text">
                          {displayNameDraft}
                        </div>
                        <div className="mt-1 truncate text-xs text-nkc-muted">
                          {statusDraft ? statusDraft : "상태 메시지가 없습니다."}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={startProfileEdit}
                            className="rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                          >
                            편집
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <label className="text-sm">
                          표시 이름
                          <input
                            value={displayNameDraft}
                            onChange={(event) => setDisplayNameDraft(event.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                          />
                        </label>
                        <label className="mt-3 text-sm">
                          상태 메시지
                          <input
                            value={statusDraft}
                            onChange={(event) => setStatusDraft(event.target.value)}
                            className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                          />
                        </label>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <label className="cursor-pointer rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel">
                            사진 업로드
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(event) =>
                                event.target.files?.[0] && onUploadPhoto(event.target.files[0])
                              }
                            />
                          </label>
                          <button
                            type="button"
                            onClick={saveProfileEdit}
                            className="rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg"
                          >
                            저장
                          </button>
                          <button
                            type="button"
                            onClick={cancelProfileEdit}
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
                  {settingsMenu.map((item, index) => {
                    const Icon = item.icon;
                    const isLast = index === settingsMenu.length - 1;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={item.onClick}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-nkc-text hover:bg-nkc-panel ${
                          isLast ? "" : "border-b border-nkc-border"
                        }`}
                      >
                        <Icon size={16} className="text-nkc-muted" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : null}

          {view === "privacy" ? (
            <div className="mt-6 grid gap-6">
              {renderSubHeader("개인정보 보호")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-nkc-text">보안</h3>
                  <button
                    onClick={onLock}
                    className="flex items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                  >
                    <Lock size={14} /> 잠금
                  </button>
                </div>
                <div className="mt-4 grid gap-3">
                  <label className="flex items-center justify-between text-sm">
                    <span>PIN 잠금</span>
                    <input
                      type="checkbox"
                      checked={pinEnabled || pinPending}
                      onChange={async (event) => {
                        const next = event.target.checked;
                        setPinError("");
                        if (!next) {
                          setPinPending(false);
                          setPinDraft("");
                          if (pinEnabled) {
                            await onDisablePin();
                          }
                          return;
                        }
                        setPinPending(true);
                      }}
                    />
                  </label>
                  {pinEnabled || pinPending ? (
                    <div className="grid gap-2">
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="\\d*"
                        maxLength={8}
                        value={pinDraft}
                        onChange={(event) => setPinDraft(event.target.value)}
                        placeholder="4-8자리"
                        className="w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-sm"
                      />
                      <button
                        onClick={async () => {
                          setPinError("");
                          const result = await onSetPin(pinDraft);
                          if (!result.ok) {
                            setPinError(result.error || "PIN 설정에 실패했습니다.");
                          }
                        }}
                        className="w-fit rounded-nkc bg-nkc-accent px-3 py-2 text-xs font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!pinDraft}
                      >
                        PIN 저장
                      </button>
                    </div>
                  ) : null}
                  {pinError ? <div className="text-xs text-red-300">{pinError}</div> : null}
                  <button
                    onClick={onOpenRecovery}
                    className="flex w-fit items-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                  >
                    <KeyRound size={14} />
                    복구키 관리
                  </button>
                </div>
              </section>
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">읽음 확인</div>
                      <div className="text-xs text-nkc-muted">메시지 읽음 여부 공유</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={privacyPrefs.readReceipts}
                      onChange={(event) =>
                        updatePrivacy({ ...privacyPrefs, readReceipts: event.target.checked })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">입력 중 표시</div>
                      <div className="text-xs text-nkc-muted">상대에게 입력 중 상태 표시</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={privacyPrefs.typingIndicator}
                      onChange={(event) =>
                        updatePrivacy({
                          ...privacyPrefs,
                          typingIndicator: event.target.checked,
                        })
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
                      disabled={netConfig.disableLinkPreview}
                      onChange={(event) =>
                        updatePrivacy({ ...privacyPrefs, linkPreviews: event.target.checked })
                      }
                    />
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {view === "theme" ? (
            <div className="mt-6 grid gap-6">
              {renderSubHeader("테마")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="mt-1 flex flex-wrap gap-3">
                  {themeOptions.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setTheme(option.value)}
                      className={`rounded-nkc border px-4 py-2 text-xs ${
                        theme === option.value
                          ? "border-nkc-accent bg-nkc-panel text-nkc-text"
                          : "border-nkc-border text-nkc-muted hover:bg-nkc-panel"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                    닫기
                  </button>
                </Dialog.Close>
                <button
                  onClick={async () => {
                    try {
                      await onSaveProfile({ displayName, status, theme });
                      setSaveMessage("저장했습니다");
                    } catch (error) {
                      console.error("Failed to save profile", error);
                    }
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
          ) : null}

          {view === "network" ? (
            <div className="mt-6 grid gap-6">
              {renderSubHeader("네트워크 / 프라이버시")}
              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-6">
                <div className="grid gap-4 text-sm">
                  <div>
                    <div className="text-sm font-semibold text-nkc-text">연결 방식</div>
                    <div className="mt-3 grid gap-2">
                      <label className="flex items-center justify-between text-sm">
                        <span>Auto (권장)</span>
                        <input
                          type="radio"
                          name="network-mode"
                          checked={netConfig.mode === "auto"}
                          onChange={() => setMode("auto")}
                        />
                      </label>
                      <label className="flex items-center justify-between text-sm">
                        <span>Self-Onion (분산)</span>
                        <input
                          type="radio"
                          name="network-mode"
                          checked={netConfig.mode === "selfOnion"}
                          onChange={() => setMode("selfOnion")}
                        />
                      </label>
                      <label className="flex items-center justify-between text-sm">
                        <span>Onion Router (익명)</span>
                        <input
                          type="radio"
                          name="network-mode"
                          checked={netConfig.mode === "onionRouter"}
                          onChange={() => setMode("onionRouter")}
                        />
                      </label>
                      <label className="flex items-center justify-between text-sm">
                        <span>Direct P2P (빠름)</span>
                        <input
                          type="radio"
                          name="network-mode"
                          checked={netConfig.mode === "directP2P"}
                          onChange={() => setMode("directP2P")}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="text-xs text-nkc-muted leading-relaxed">
                    <p>Self-Onion은 가능한 한 분산된 릴레이를 사용합니다.</p>
                    <p>문제가 감지되면 Onion Router로 자동 전환될 수 있습니다.</p>
                    <p>익명 우선 모드는 IP 노출을 줄이지만 지연이 늘 수 있습니다.</p>
                  </div>
                </div>
              </section>

              <section className="rounded-nkc border border-nkc-border bg-nkc-panelMuted">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">Onion 프록시 사용</div>
                      <div className="text-xs text-nkc-muted">
                        Lokinet 로컬 프록시를 경유합니다.
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={netConfig.onionProxyEnabled}
                      disabled={isOnionRouterMode}
                      onChange={(event) => setProxy(event.target.checked)}
                    />
                  </div>
                  <div className="border-b border-nkc-border px-4 py-3">
                    <label className="text-sm">
                      Onion 프록시 URL
                      <input
                        value={netConfig.onionProxyUrl}
                        onChange={(event) =>
                          setProxy(netConfig.onionProxyEnabled, event.target.value)
                        }
                        placeholder="socks5://127.0.0.1:9050"
                        className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                      />
                    </label>
                    <div className="mt-2 text-xs text-nkc-muted">
                      Lokinet을 로컬에서 실행하고 프록시 주소를 입력하세요.
                    </div>
                    {isAutoMode ? (
                      <div className="mt-1 text-xs text-nkc-muted">
                        Auto 모드는 폴백 시 프록시가 자동으로 켜질 수 있습니다.
                      </div>
                    ) : null}
                    <div className="mt-2 text-xs text-nkc-muted">{proxyStatusLabel}</div>
                  </div>
                  <div className="flex items-center justify-between gap-4 border-b border-nkc-border px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">WebRTC 직통 제한</div>
                      <div className="text-xs text-nkc-muted">릴레이만 사용</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={netConfig.webrtcRelayOnly}
                      disabled={isOnionRouterMode}
                      onChange={(event) => setRelayOnly(event.target.checked)}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-nkc-text">링크 미리보기 끄기</div>
                      <div className="text-xs text-nkc-muted">익명 모드 권장</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={netConfig.disableLinkPreview}
                      disabled={isOnionRouterMode}
                      onChange={(event) => setDisableLinkPreview(event.target.checked)}
                    />
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {view === "friends" ? (
            <div className="mt-6 grid gap-6">
              {renderSubHeader("친구 관리")}
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
                              onClick={() => onUnhideFriend(friend.id)}
                              className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              표시
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        숨긴 친구가 없습니다.
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
                              onClick={() => onUnblockFriend(friend.id)}
                              className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                            >
                              차단 해제
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-nkc border border-dashed border-nkc-border px-3 py-2 text-xs text-nkc-muted">
                        차단한 친구가 없습니다.
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {view === "danger" ? (
            <div className="mt-6 grid gap-6">
              {renderSubHeader("위험 구역")}
              <section className="rounded-nkc border border-red-500/50 bg-red-500/20 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-red-100">위험 구역</h3>
                    <p className="mt-1 text-xs text-red-100/80">
                      로그아웃 또는 초기화는 복구키 없이는 되돌릴 수 없습니다.
                    </p>
                  </div>
                  <ShieldAlert className="text-red-100" size={18} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={onLogout}
                    className="rounded-nkc border border-red-400/60 px-3 py-2 text-xs text-red-100 hover:bg-red-500/20"
                  >
                    로그아웃
                  </button>
                  <button
                    onClick={onWipe}
                    className="rounded-nkc border border-red-300 bg-red-500/30 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/40"
                  >
                    초기화
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {view === "main" ? (
            <>
              <div className="mt-6 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                    닫기
                  </button>
                </Dialog.Close>
                <button
                  onClick={async () => {
                    try {
                      await onSaveProfile({ displayName, status, theme });
                      setSaveMessage("저장했습니다");
                    } catch (error) {
                      console.error("Failed to save profile", error);
                    }
                  }}
                  className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg"
                >
                  저장
                </button>
              </div>
              {saveMessage ? (
                <div className="mt-2 text-right text-xs text-nkc-muted">{saveMessage}</div>
              ) : null}
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
