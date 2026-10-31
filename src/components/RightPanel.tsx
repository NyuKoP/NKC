import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ChevronLeft, ChevronRight, Image as ImageIcon, Settings, UserPlus, UserX, X } from "lucide-react";
import {
  listMessagesByConv,
  loadMessageMedia,
  type AvatarRef,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import Avatar from "./Avatar";
import { resolveDisplayName, resolveFriendDisplayName } from "../utils/displayName";
import { groupMessages } from "../ui/groupMessages";
import { subscribeMessageMediaReady } from "../storage/mediaReady";
import { presenceDotClass, resolvePresenceStatus } from "../profile/presence";
import { useAppStore } from "../app/store";

const tabs = [
  { value: "about", ko: "프로필", en: "Profile" },
  { value: "media", ko: "미디어", en: "Media" },
  { value: "settings", ko: "설정", en: "Settings" },
] as const;

type RightPanelProps = {
  open: boolean;
  onClose: () => void;
  tab: "about" | "media" | "settings";
  onTabChange: (tab: "about" | "media" | "settings") => void;
  conversation: Conversation | null;
  friendProfile?: UserProfile | null;
  currentUserId: string | null;
  profilesById: Record<string, UserProfile | undefined>;
  groupAvatarRef?: AvatarRef;
  groupAvatarOverrideRef?: string | null;
  friendAliasesById: Record<string, string | undefined>;
  trustState: "UNVERIFIED" | "VERIFIED" | "KEY_CHANGED";
  onOpenSettings: () => void;
  onInviteToGroup: (convId: string) => void;
  onLeaveGroup: (convId: string) => void;
  onSetGroupAvatarOverride: (convId: string, file: File | null) => void | Promise<void>;
  onToggleMute: (convId: string) => void;
  onTogglePin: (convId: string) => void;
  onHideConversation: (convId: string) => void;
  onToggleBlock: (convId: string) => void;
};

const isTabValue = (value: string): value is RightPanelProps["tab"] =>
  value === "about" || value === "media" || value === "settings";

const isGroupConversation = (conversation: Conversation | null) =>
  Boolean(conversation && (conversation.type === "group" || conversation.participants.length > 2));

type MediaFilter = "images" | "videos" | "files";

type MediaItem = { message: Message; media: NonNullable<Message["media"]> };

type MediaGroup = { id: string; items: MediaItem[] };

type MediaSection = { key: string; label: string; groups: MediaGroup[] };

const shortenValue = (value: string) => {
  if (value.length <= 18) return value;

  return `${value.slice(0, 10)}…${value.slice(-6)}`;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const digits = size >= 10 || unit === 0 ? 0 : 1;

  return `${size.toFixed(digits)} ${units[unit]}`;
};

export default function RightPanel({
  open,
  onClose,
  tab,
  onTabChange,
  conversation,
  friendProfile,
  currentUserId,
  profilesById,
  groupAvatarRef,
  groupAvatarOverrideRef,
  friendAliasesById,
  trustState,
  onOpenSettings,
  onInviteToGroup,
  onLeaveGroup,
  onSetGroupAvatarOverride,
  onToggleMute,
  onTogglePin,
  onHideConversation,
  onToggleBlock,
}: RightPanelProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = useCallback((ko: string, en: string) => language === "ko" ? ko : en, [language]);
  const directDisplayName = resolveFriendDisplayName(friendProfile ?? undefined, friendAliasesById);

  const displayName =
    conversation && (conversation.type === "group" || conversation.participants.length > 2)
      ? conversation.name
      : directDisplayName;

  const isGroup = isGroupConversation(conversation);
  const memberIds = conversation?.participants ?? [];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasOverride = Boolean(groupAvatarOverrideRef);
  const [mediaMessages, setMediaMessages] = useState<Message[]>([]);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("images");
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaFailures, setMediaFailures] = useState<Record<string, string>>({});
  const [mediaPreviewUrls, setMediaPreviewUrls] = useState<Record<string, string>>({});
  const [mediaPreviewBusy, setMediaPreviewBusy] = useState<Record<string, boolean>>({});
  const mediaPreviewRunRef = useRef(0);
  const mediaPreviewUrlsRef = useRef<Record<string, string>>({});
  const mediaPreviewBusyRef = useRef<Record<string, boolean>>({});
  const [mediaRefreshKey, setMediaRefreshKey] = useState(0);
  const [viewerGroup, setViewerGroup] = useState<MediaGroup | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [presenceNow, setPresenceNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setPresenceNow(Date.now()), 30_000);

    return () => window.clearInterval(interval);
  }, []);

  const aboutAvatarRef = isGroup ? groupAvatarRef : friendProfile?.avatarRef;

  const aboutAvatarName = isGroup
    ? conversation?.name || "Group"
    : directDisplayName;

  const friendPresence = resolvePresenceStatus(friendProfile?.presence, presenceNow);

  const friendPresenceLabel =
    friendPresence === "online"
      ? "온라인"
      : friendPresence === "idle"
        ? "자리 비움"
        : friendPresence === "dnd"
          ? "방해 금지"
          : "오프라인";

  const members = memberIds.map((id) => {
    const profile = profilesById[id];

    return {
      id,
      name:
        id === currentUserId
          ? t("나", "Me")
          : resolveDisplayName({
              alias: profile ? friendAliasesById[profile.id] : undefined,
              displayName: profile?.displayName,
              friendId: profile?.friendId,
              id: profile?.id ?? id,
            }),
      avatarRef: profile?.avatarRef,
      status: profile?.status,
      isSelf: id === currentUserId,
    };
  });

  const handleOverrideChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!conversation || !isGroup) return;
    const file = event.target.files?.[0] ?? null;
    void onSetGroupAvatarOverride(conversation.id, file);
    event.target.value = "";
  };

  useEffect(() => {
    if (tab !== "media" || !conversation) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setMediaLoading(true);
      setMediaError(null);
    });
    listMessagesByConv(conversation.id)
      .then((messages) => {
        if (!active) return;
        const withMedia = messages.filter((message) => Boolean(message.media));
        withMedia.sort((a, b) => b.ts - a.ts);
        setMediaMessages(withMedia);
      })
      .catch((error) => {
        if (!active) return;
        console.error("Failed to load media", error);
        setMediaError(t("미디어를 불러오지 못했습니다.", "Could not load media."));
      })
      .finally(() => {
        if (!active) return;
        setMediaLoading(false);
      });

    return () => {
      active = false;
    };
  }, [conversation, tab, mediaRefreshKey, t]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { convId?: string } | undefined;

      if (detail?.convId && conversation && detail.convId !== conversation.id) return;
      setMediaRefreshKey(Date.now());
    };

    window.addEventListener("nkc:messages-updated", handler);

    return () => {
      window.removeEventListener("nkc:messages-updated", handler);
    };
  }, [conversation]);

  useEffect(
    () =>
      subscribeMessageMediaReady(() => {
        setMediaRefreshKey((value) => value + 1);
      }),
    []
  );

  const filteredMedia = useMemo(() => {
    return mediaMessages.filter((message) => {
      const media = message.media;

      if (!media) return false;
      const mime = media.mime || "";
      const isImage = mime.startsWith("image/");
      const isVideo = mime.startsWith("video/");

      return mediaFilter === "images"
        ? isImage
        : mediaFilter === "videos"
          ? isVideo
          : !isImage && !isVideo;
    });
  }, [mediaFilter, mediaMessages]);

  const groupedMedia = useMemo<MediaSection[]>(() => {
    const sections = new Map<
      string,
      { section: MediaSection; groupMap: Map<string, MediaGroup> }
    >();

    const grouped = groupMessages(
      filteredMedia.map((message) => ({
        ...message,
        createdAt: message.ts,
        kind: "media",
      }))
    );

    const ordered = [...grouped].sort((a, b) => {
      const timeDelta = b.createdAt - a.createdAt;

      if (timeDelta !== 0) return timeDelta;

      return a.key.localeCompare(b.key);
    });

    for (const group of ordered) {
      const date = new Date(group.createdAt);
      const sectionKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const sectionLabel = sectionKey;
      let entry = sections.get(sectionKey);

      if (!entry) {
        entry = {
          section: { key: sectionKey, label: sectionLabel, groups: [] },
          groupMap: new Map<string, MediaGroup>(),
        };
        sections.set(sectionKey, entry);
      }

      let mediaGroup = entry.groupMap.get(group.key);

      if (!mediaGroup) {
        mediaGroup = { id: group.key, items: [] };
        entry.groupMap.set(group.key, mediaGroup);
        entry.section.groups.push(mediaGroup);
      }

      group.items.forEach((item) => {
        if (!item.media) return;
        mediaGroup?.items.push({ message: item, media: item.media });
      });
    }

    return Array.from(sections.values()).map((entry) => entry.section);
  }, [filteredMedia]);

  useEffect(() => {
    if (tab !== "media") return;
    let active = true;
    const activeIds = new Set(filteredMedia.map((message) => message.id));
    queueMicrotask(() => {
      if (!active) return;
      setMediaPreviewUrls((prev) => {
        let changed = false;
        const next: Record<string, string> = {};

        for (const [id, url] of Object.entries(prev)) {
          if (activeIds.has(id)) {
            next[id] = url;
          } else {
            URL.revokeObjectURL(url);
            changed = true;
          }
        }

        return changed ? next : prev;
      });
      setMediaPreviewBusy((prev) => {
        let changed = false;
        const next: Record<string, boolean> = {};

        for (const [id, busy] of Object.entries(prev)) {
          if (activeIds.has(id)) {
            next[id] = busy;
          } else {
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    });

    return () => {
      active = false;
    };
  }, [filteredMedia, tab]);

  useEffect(() => {
    mediaPreviewUrlsRef.current = mediaPreviewUrls;
  }, [mediaPreviewUrls]);

  useEffect(() => {
    mediaPreviewBusyRef.current = mediaPreviewBusy;
  }, [mediaPreviewBusy]);

  useEffect(() => {
    if (open && tab === "media") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setMediaPreviewUrls((prev) => {
        Object.values(prev).forEach((url) => URL.revokeObjectURL(url));

        return {};
      });
      setMediaPreviewBusy({});
    });

    return () => {
      active = false;
    };
  }, [open, tab]);

  useEffect(() => () => {
    Object.values(mediaPreviewUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    mediaPreviewUrlsRef.current = {};
  }, []);

  useEffect(() => {
    const runId = (mediaPreviewRunRef.current += 1);
    if (!open || tab !== "media") return;

    const loadPreviews = async () => {
      for (const message of filteredMedia) {
        const media = message.media;

        if (!media) continue;

        if (!media.mime?.startsWith("image/") && !media.mime?.startsWith("video/")) continue;

        if (mediaPreviewUrlsRef.current[message.id]) continue;

        if (mediaPreviewBusyRef.current[message.id]) continue;
        setMediaPreviewBusy((prev) => ({ ...prev, [message.id]: true }));
        const blob = await loadMessageMedia(media);

        if (runId !== mediaPreviewRunRef.current) return;

        if (!blob) {
          setMediaPreviewBusy((prev) => {
            const next = { ...prev };
            delete next[message.id];

            return next;
          });
          continue;
        }

        const url = URL.createObjectURL(blob);
        mediaPreviewUrlsRef.current = { ...mediaPreviewUrlsRef.current, [message.id]: url };
        setMediaFailures((prev) => {
          if (!(message.id in prev)) return prev;
          const next = { ...prev };
          delete next[message.id];

          return next;
        });
        setMediaPreviewUrls((prev) => ({ ...prev, [message.id]: url }));
        setMediaPreviewBusy((prev) => {
          const next = { ...prev };
          delete next[message.id];

          return next;
        });
      }
    };

    void loadPreviews();
    return () => { mediaPreviewRunRef.current += 1; };
  }, [filteredMedia, mediaRefreshKey, open, tab]);

  const handleCopyValue = async (value: string) => {
    if (!value || value === "—") return;

    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
    } catch (error) {
      console.error("Failed to copy value", error);
    }
  };

  const handleDownloadItem = async (item: MediaItem) => {
    const media = item.media;
    const blob = await loadMessageMedia(media);

    if (!blob) {
      setMediaFailures((prev) => ({ ...prev, [item.message.id]: t("다운로드에 실패했습니다.", "Download failed. Please try again.") }));

      return;
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (media.name || "media").replace(/[^a-zA-Z0-9.\-_가-힣]/g, "_");
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleDownloadGroup = async (group: MediaGroup) => {
    for (const item of group.items) {
      await handleDownloadItem(item);
    }
  };

  const openViewer = (group: MediaGroup, index = 0) => {
    setViewerGroup(group);
    setViewerIndex(index);
  };

  const closeViewer = () => {
    setViewerGroup(null);
    setViewerIndex(0);
  };

  const peerIdValue = friendProfile?.friendId || friendProfile?.id || "—";
  const peerIdDisplay = peerIdValue === "—" ? "—" : shortenValue(peerIdValue);
  const identityKeyValue = friendProfile?.identityPub || "—";
  const identityKeyDisplay = identityKeyValue === "—" ? "—" : shortenValue(identityKeyValue);

  const trustLabel =
    trustState === "VERIFIED"
      ? t("검증됨", "Verified")
      : trustState === "KEY_CHANGED"
        ? t("키 변경됨", "Key changed")
        : t("미검증", "Unverified");

  const safetyNumber = friendProfile?.verification?.safetyNumber;

  if (!open) return null;

  return (
    <>
    <div
      aria-hidden="true"
      onClick={onClose}
      className="fixed inset-0 z-40 bg-black/45 lg:hidden"
    />
    <aside
      data-testid="right-panel"
      aria-label={t("대화 정보", "Conversation info")}
      className="fixed inset-y-0 right-0 z-50 h-full w-[min(320px,calc(100vw-32px))] overflow-hidden border-l border-nkc-border bg-nkc-panel lg:static lg:z-auto lg:w-[320px] animate-signal-slide-in-right"
    >
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (isTabValue(value)) onTabChange(value);
        }}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex items-center gap-2 p-4 pb-2">
          <Tabs.List className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-lg bg-nkc-hover p-1 text-xs">
            {tabs.map((item) => (
              <Tabs.Trigger
                key={item.value}
                value={item.value}
                className="rounded-md px-2 py-1.5 font-semibold text-nkc-muted transition-colors hover:text-nkc-text data-[state=active]:bg-nkc-panel data-[state=active]:text-nkc-text"
              >
                {language === "en" ? item.en : item.ko}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("대화 정보 닫기", "Close conversation info")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex w-full min-h-0 flex-1 flex-col items-stretch justify-start px-4 pb-3 pt-[3px]">
        <Tabs.Content
          value="about"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden focus:outline-none data-[state=inactive]:hidden"
        >
          {conversation ? (
            <div className="flex min-h-full w-full flex-col overflow-hidden rounded-xl border border-nkc-border bg-nkc-surface">
              <section>
                <div className="px-5 pb-5 pt-6">
                  <div className="relative inline-flex">
                    <Avatar
                      name={aboutAvatarName}
                      colorKey={isGroup ? conversation.id : friendProfile?.id ?? conversation.id}
                      avatarRef={aboutAvatarRef}
                      size={72}
                    />
                    {!isGroup ? (
                      <span
                        className={`absolute bottom-0 right-0 h-5 w-5 rounded-full border-[4px] border-nkc-surface ${presenceDotClass(friendPresence)}`}
                        aria-label={friendPresenceLabel}
                        title={friendPresenceLabel}
                      />
                    ) : null}
                  </div>
                  <h2 className="mt-3 truncate text-xl font-bold tracking-[-0.02em] text-nkc-text">
                    {displayName || conversation.name}
                  </h2>
                  <div className="mt-1.5 text-xs font-medium text-nkc-muted">
                    {isGroup ? t(`멤버 ${members.length}명`, `${members.length} ${members.length === 1 ? "member" : "members"}`) : friendPresenceLabel}
                  </div>
                  {!isGroup && friendProfile?.status?.trim() ? (
                    <div className="mt-5 min-h-[88px]">
                      <div className="text-[11px] font-bold text-nkc-muted">{t("상태 메시지", "Status message")}</div>
                      <p
                        className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-[18px] tracking-[-0.015em] text-nkc-text"
                        style={{ fontFamily: 'Arial, Dotum, "돋움", sans-serif' }}
                      >
                        {friendProfile.status.trim()}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              {!isGroup ? (
                <>
                  <div className="flex items-center justify-between gap-3 border-y border-nkc-divider px-5 py-3.5">
                    <span className="text-xs font-semibold text-nkc-muted">{t("신뢰 상태", "Trust status")}</span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${
                        trustState === "VERIFIED"
                          ? "bg-nkc-successBg text-nkc-success"
                          : trustState === "KEY_CHANGED"
                            ? "bg-nkc-dangerBg text-nkc-danger"
                            : "bg-nkc-panelMuted text-nkc-muted"
                      }`}
                    >
                      {trustLabel}
                    </span>
                  </div>
                  <details className="group border-b border-nkc-divider">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold text-nkc-text hover:bg-nkc-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nkc-focusRing">
                      {t("보안 식별 정보 보기", "Show security identifiers")}<span aria-hidden="true" className="text-base text-nkc-muted transition-transform group-open:rotate-90">›</span>
                    </summary>
                    <dl className="space-y-3 px-5 pb-5 text-xs">
                      <div>
                        <dt className="text-[11px] font-medium text-nkc-muted">Peer ID</dt>
                        <dd className="mt-1 flex min-w-0 items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded-lg bg-nkc-panelMuted px-2.5 py-2 font-mono text-[11px] text-nkc-text" title={peerIdValue}>
                            {peerIdDisplay}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyValue(peerIdValue)}
                            disabled={peerIdValue === "—"}
                            className="shrink-0 rounded-lg px-2.5 py-2 text-[11px] font-semibold text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-40"
                          >
                            {t("복사", "Copy")}</button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-medium text-nkc-muted">{t("신원 키 지문", "Identity key fingerprint")}</dt>
                        <dd className="mt-1 flex min-w-0 items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded-lg bg-nkc-panelMuted px-2.5 py-2 font-mono text-[11px] text-nkc-text" title={identityKeyValue}>
                            {identityKeyDisplay}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyValue(identityKeyValue)}
                            disabled={identityKeyValue === "—"}
                            className="shrink-0 rounded-lg px-2.5 py-2 text-[11px] font-semibold text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-40"
                          >
                            {t("복사", "Copy")}</button>
                        </dd>
                      </div>
                      {safetyNumber ? (
                        <div>
                          <dt className="text-[11px] font-medium text-nkc-muted">{t("안전 번호", "Safety number")}</dt>
                          <dd className="mt-1 flex min-w-0 items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-lg bg-nkc-panelMuted px-2.5 py-2 font-mono text-[11px] text-nkc-text" title={safetyNumber}>
                              {shortenValue(safetyNumber)}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopyValue(safetyNumber)}
                              className="shrink-0 rounded-lg px-2.5 py-2 text-[11px] font-semibold text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
                            >
                              {t("복사", "Copy")}</button>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </details>
                </>
              ) : null}

              {isGroup ? (
                <>
                  <div className="mx-5 border-t border-nkc-border pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-nkc-muted">{t("그룹 이미지 (나만)", "Group image (only me)")}</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                        >
                          {t("변경", "Change")}</button>
                        {hasOverride ? (
                          <button
                            type="button"
                            onClick={() => onSetGroupAvatarOverride(conversation.id, null)}
                            className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                          >
                            {t("해제", "Remove")}</button>
                        ) : null}
                      </div>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      className="hidden"
                      onChange={handleOverrideChange}
                    />
                    {hasOverride ? (
                      <div className="mt-1 text-[11px] text-nkc-muted">
                        {t("이 설정은 내 기기에서만 보입니다.", "This setting is only visible on this device.")}</div>
                    ) : null}
                  </div>

                  <div className="mx-5 border-t border-nkc-border pt-3">
                    <div className="text-xs font-semibold text-nkc-muted">{t("멤버 (", "Members (")}{members.length})</div>
                    <div className="mt-2 space-y-1">
                      {members.map((member) => (
                        <div key={member.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-nkc-hover">
                          <Avatar name={member.name} colorKey={member.id} avatarRef={member.avatarRef} size={28} />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-nkc-text line-clamp-1">
                              {member.name}
                            </div>
                            {member.status ? (
                              <div className="text-[11px] text-nkc-muted line-clamp-1">{member.status}</div>
                            ) : null}
                          </div>
                          {member.isSelf ? (
                            <span className="ml-auto rounded-full bg-nkc-surface px-2 py-0.5 text-[10px] text-nkc-muted">
                              {t("나", "Me")}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mx-5 mb-5 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onInviteToGroup(conversation.id)}
                      className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-nkc-accent px-3 text-xs font-semibold text-white hover:brightness-110"
                    >
                      <UserPlus size={14} />
                      {t("초대", "Invite")}</button>
                    <button
                      type="button"
                      onClick={() => onLeaveGroup(conversation.id)}
                      className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-nkc-dangerBg px-3 text-xs font-semibold text-nkc-danger hover:bg-nkc-dangerBg"
                    >
                      <UserX size={14} />
                      {t("나가기", "Leave")}</button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="w-full rounded-lg p-4 text-center text-sm text-nkc-muted">
              {t("대화를 선택하면 상세 정보가 표시됩니다.", "Select a conversation to see its details.")}</div>
          )}
        </Tabs.Content>
        <Tabs.Content
          value="media"
          className="min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hidden focus:outline-none data-[state=active]:flex data-[state=inactive]:hidden"
        >
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-center gap-1 rounded-lg bg-nkc-hover p-1 text-xs">
              {([
                { value: "images", label: "Images" },
                { value: "videos", label: "Videos" },
                { value: "files", label: "Files" },
              ] as const).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setMediaFilter(item.value)}
                  className={
                    mediaFilter === item.value
                      ? "flex h-8 flex-1 items-center justify-center rounded-md bg-nkc-panel px-3 text-[11px] font-semibold text-nkc-text"
                      : "flex h-8 flex-1 items-center justify-center rounded-md px-3 text-[11px] font-semibold text-nkc-muted hover:text-nkc-text"
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {mediaLoading ? (
              <div className="w-full rounded-lg p-4 text-xs text-nkc-muted">
                {t("미디어를 불러오는 중...", "Loading media...")}</div>
            ) : mediaError ? (
              <div className="w-full rounded-lg p-4 text-xs text-nkc-muted">
                {mediaError}
              </div>
            ) : groupedMedia.length ? (
              <div className="space-y-4">
                {groupedMedia.map((section) => (
                  <div key={section.key} className="space-y-2">
                    <div className="text-[11px] font-semibold text-nkc-muted">{section.label}</div>
                    <div className="space-y-2">
                      {section.groups.map((group) => {
                        const first = group.items[0];
                        const firstMedia = first?.media;
                        const failed = first ? mediaFailures[first.message.id] : null;

                        return (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => openViewer(group, 0)}
                            className="w-full overflow-hidden rounded-lg bg-nkc-hover p-3 text-left text-xs hover:bg-nkc-surface"
                          >
                            <div className="mb-2 flex items-center justify-between">
                              <div className="font-semibold text-nkc-text">
                                {group.items.length}{t("장", "images")}</div>
                              <div className="text-[11px] text-nkc-muted">
                                {first?.message.ts ? new Date(first.message.ts).toLocaleString() : ""}
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              {group.items.map((item) => {
                                const previewUrl = mediaPreviewUrls[item.message.id];
                                const isImage = item.media.mime?.startsWith("image/");
                                const isVideo = item.media.mime?.startsWith("video/");

                                return (
                                  <div
                                    key={item.message.id}
                                    className="min-w-0 rounded-lg bg-nkc-surface p-1"
                                  >
                                    {previewUrl && isImage ? (
                                      <img
                                        src={previewUrl}
                                        alt={item.media.name || "preview"}
                                        className="h-16 w-full rounded-lg object-cover"
                                      />
                                    ) : previewUrl && isVideo ? (
                                      <video
                                        src={previewUrl}
                                        className="h-16 w-full rounded-lg object-cover"
                                        muted
                                        playsInline
                                        preload="metadata"
                                      />
                                    ) : (
                                      <div className="flex h-16 items-center justify-center text-[10px] text-nkc-muted">
                                        {t("미리보기 없음", "No preview")}</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {firstMedia ? (
                              <div className="mt-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-nkc-muted">
                                <span className="min-w-0 flex-1 truncate">
                                  {firstMedia.name || "Unnamed"}
                                </span>
                                <span className="shrink-0">{formatBytes(firstMedia.size)}</span>
                              </div>
                            ) : null}
                            {failed ? (
                              <div className="mt-2 text-[11px] text-nkc-danger">{failed}</div>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[240px] w-full flex-col items-center justify-center rounded-lg p-6 text-center text-xs text-nkc-muted">
                <ImageIcon size={32} className="mb-3 opacity-40" />
                <p>{t("표시할 미디어가 없습니다.", "No media to show.")}</p>
              </div>
            )}
          </div>
          {viewerGroup ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="relative w-full max-w-3xl rounded-xl bg-nkc-surface p-4">
                <button
                  type="button"
                  onClick={closeViewer}
                  className="absolute right-4 top-4 rounded-md bg-nkc-hover px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel"
                >
                  {t("닫기", "Close")}</button>
                <div className="flex items-center justify-between text-xs text-nkc-muted pr-10">
                  <span className="line-clamp-1">
                    {viewerGroup.items[viewerIndex]?.media.name || "미디어"}
                  </span>
                </div>
                <div className="group relative mt-3 flex items-center justify-center">
                  {(() => {
                    const item = viewerGroup.items[viewerIndex];

                    if (!item) return null;
                    const previewUrl = mediaPreviewUrls[item.message.id];
                    const isImage = item.media.mime?.startsWith("image/");
                    const isVideo = item.media.mime?.startsWith("video/");

                    if (previewUrl && isImage) {
                      return (
                        <img
                          src={previewUrl}
                          alt={item.media.name || "preview"}
                          className="max-h-[60vh] w-full rounded-lg object-contain"
                        />
                      );
                    }

                    if (previewUrl && isVideo) {
                      return (
                        <video
                          src={previewUrl}
                          className="max-h-[60vh] w-full rounded-lg object-contain"
                          controls
                          playsInline
                          preload="metadata"
                        />
                      );
                    }

                    return (
                      <div className="flex h-[40vh] w-full items-center justify-center text-sm text-nkc-muted">
                        {t("미리보기를 불러오는 중...", "Loading preview...")}</div>
                    );
                  })()}
                  {viewerGroup.items.length > 1 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setViewerIndex((prev) => Math.max(0, prev - 1))}
                        disabled={viewerIndex === 0}
                        aria-label={t("이전 사진", "Previous photo")}
                        className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-lg transition-opacity duration-100 ease-out hover:bg-black/75 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-nkc-focusRing group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:invisible"
                      >
                        <ChevronLeft size={24} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewerIndex((prev) => Math.min(viewerGroup.items.length - 1, prev + 1))}
                        disabled={viewerIndex >= viewerGroup.items.length - 1}
                        aria-label={t("다음 사진", "Next photo")}
                        className="pointer-events-none absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-lg transition-opacity duration-100 ease-out hover:bg-black/75 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-nkc-focusRing group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:invisible"
                      >
                        <ChevronRight size={24} />
                      </button>
                    </>
                  ) : null}
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const item = viewerGroup.items[viewerIndex];

                        if (item) void handleDownloadItem(item);
                      }}
                      className="rounded-md bg-nkc-hover px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel"
                    >
                      {t("현재 장 다운로드", "Download current image")}</button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadGroup(viewerGroup)}
                      className="rounded-md bg-nkc-hover px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel"
                    >
                      {t("전체 다운로드", "Download all")}</button>
                  </div>
                </div>
                <div className="mt-2 flex justify-center">
                  <span className="rounded-full bg-nkc-hover px-3 py-1 text-[11px] text-nkc-muted">
                    {viewerIndex + 1}/{viewerGroup.items.length}
                  </span>
                </div>
                <div className="mt-3 flex gap-2 overflow-x-auto">
                  {viewerGroup.items.map((item, idx) => {
                    const previewUrl = mediaPreviewUrls[item.message.id];
                    const isImage = item.media.mime?.startsWith("image/");
                    const isVideo = item.media.mime?.startsWith("video/");

                    return (
                      <button
                        key={item.message.id}
                        type="button"
                        onClick={() => setViewerIndex(idx)}
                        className={`h-16 w-20 rounded-md border ${
                          idx === viewerIndex ? "border-nkc-text" : "border-nkc-border"
                        }`}
                      >
                        {previewUrl && isImage ? (
                          <img
                            src={previewUrl}
                            alt={item.media.name || "thumb"}
                            className="h-full w-full rounded-md object-cover"
                          />
                        ) : previewUrl && isVideo ? (
                          <video
                            src={previewUrl}
                            className="h-full w-full rounded-md object-cover"
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-nkc-muted">
                            -
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </Tabs.Content>

        <Tabs.Content
          value="settings"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden focus:outline-none data-[state=inactive]:hidden"
        >
          {conversation ? (
            <div className="w-full flex flex-col gap-4">
              <div className="w-full divide-y divide-nkc-border/50 rounded-lg bg-nkc-hover px-4 py-1 text-xs text-nkc-muted">
                <div className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-xs font-semibold text-nkc-text">{t("알림", "Notifications")}</div>
                    <div className="mt-0.5 text-[11px]">
                      {conversation.muted ? t("알림 꺼짐", "Notifications off") : t("알림 켜짐", "Notifications on")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onToggleMute(conversation.id)}
                    className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                  >
                    {conversation.muted ? t("알림 켜기", "Enable notifications") : t("알림 끄기", "Mute notifications")}
                  </button>
                </div>

                <div className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-xs font-semibold text-nkc-text">{t("고정", "Pin")}</div>
                    <div className="mt-0.5 text-[11px]">
                      {conversation.pinned ? t("고정됨", "Pinned") : t("고정 안 됨", "Not pinned")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onTogglePin(conversation.id)}
                    className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                  >
                    {conversation.pinned ? t("고정 해제", "Unpin") : t("고정", "Pin")}
                  </button>
                </div>

                <div className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-xs font-semibold text-nkc-text">{t("대화", "Conversation")}</div>
                    <div className="mt-0.5 text-[11px]">{t("채팅방 관리", "Manage conversation")}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onHideConversation(conversation.id)}
                    className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                  >
                    {t("채팅 숨기기", "Hide chat")}</button>
                </div>

                <div className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-xs font-semibold text-nkc-text">{t("차단", "Block")}</div>
                    <div className="mt-0.5 text-[11px]">
                      {conversation.blocked ? t("차단됨", "Blocked") : t("차단 안 됨", "Not blocked")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onToggleBlock(conversation.id)}
                    className="rounded-full bg-nkc-surface px-3 py-1 text-[11px] font-medium text-nkc-text hover:bg-nkc-hover"
                  >
                    {conversation.blocked ? t("차단 해제", "Unblock") : t("차단", "Block")}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={onOpenSettings}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-nkc-surface px-3 py-2.5 text-xs font-semibold text-nkc-text hover:bg-nkc-hover"
              >
                <Settings size={14} />
                {t("전체 설정 열기", "Open all settings")}</button>
            </div>
          ) : (
            <div className="w-full rounded-lg p-4 text-center text-sm text-nkc-muted">
              {t("대화를 선택하면 설정을 볼 수 있습니다.", "Select a conversation to view settings.")}</div>
          )}
        </Tabs.Content>
        </div>
      </Tabs.Root>
    </aside>
    </>
  );
}
