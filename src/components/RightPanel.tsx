import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Settings, UserPlus, UserX } from "lucide-react";
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

const tabs = [
  { value: "about", label: "About" },
  { value: "media", label: "Media" },
  { value: "settings", label: "Settings" },
] as const;

type RightPanelProps = {
  open: boolean;
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

const detailsByName: Record<string, { status: string; lastSeen: string; note: string }> = {
  Demo: {
    status: "온라인",
    lastSeen: "방금 전",
    note: "상태/메모는 예시 데이터입니다.",
  },
};

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
  if (!open) return null;

  const directDisplayName = resolveFriendDisplayName(friendProfile ?? undefined, friendAliasesById);
  const displayName =
    conversation && (conversation.type === "group" || conversation.participants.length > 2)
      ? conversation.name
      : directDisplayName;
  const detail = displayName ? detailsByName[displayName] : undefined;
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

  const aboutAvatarRef = isGroup ? groupAvatarRef : friendProfile?.avatarRef;
  const aboutAvatarName = isGroup
    ? conversation?.name || "Group"
    : directDisplayName;

  const members = memberIds.map((id) => {
    const profile = profilesById[id];
    return {
      id,
      name:
        id === currentUserId
          ? "나"
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
    setMediaLoading(true);
    setMediaError(null);
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
        setMediaError("미디어를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!active) return;
        setMediaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [conversation, tab, mediaRefreshKey]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { convId?: string } | undefined;
      if (detail?.convId && conversation && detail.convId !== conversation.id) return;
      setMediaRefreshKey(Date.now());
    };
    window.addEventListener("nkc:messages-updated", handler as EventListener);
    return () => {
      window.removeEventListener("nkc:messages-updated", handler as EventListener);
    };
  }, [conversation]);

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
    const activeIds = new Set(filteredMedia.map((message) => message.id));
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
  }, [filteredMedia, tab]);

  useEffect(() => {
    mediaPreviewUrlsRef.current = mediaPreviewUrls;
  }, [mediaPreviewUrls]);

  useEffect(() => {
    mediaPreviewBusyRef.current = mediaPreviewBusy;
  }, [mediaPreviewBusy]);

  useEffect(() => {
    if (tab === "media") return;
    setMediaPreviewUrls((prev) => {
      Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });
    setMediaPreviewBusy({});
  }, [tab]);

  useEffect(() => {
    if (tab !== "media") return;
    const runId = (mediaPreviewRunRef.current += 1);
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
          setMediaFailures((prev) => ({ ...prev, [message.id]: "미리보기를 불러오지 못했습니다." }));
          setMediaPreviewBusy((prev) => {
            const next = { ...prev };
            delete next[message.id];
            return next;
          });
          continue;
        }
        const url = URL.createObjectURL(blob);
        setMediaPreviewUrls((prev) => ({ ...prev, [message.id]: url }));
        setMediaPreviewBusy((prev) => {
          const next = { ...prev };
          delete next[message.id];
          return next;
        });
      }
    };
    void loadPreviews();
  }, [filteredMedia, tab]);

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
      setMediaFailures((prev) => ({ ...prev, [item.message.id]: "다운로드에 실패했습니다." }));
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = media.name || "media";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
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
      ? "검증됨"
      : trustState === "KEY_CHANGED"
        ? "⚠ 키가 변경되었습니다. 주의하세요."
        : "미검증";

  return (
    <aside className="hidden h-full w-[320px] rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft lg:block">
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (isTabValue(value)) onTabChange(value);
        }}
        className="flex h-full min-h-0 flex-col"
      >
        <Tabs.List className="grid grid-cols-3 gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-xs">
          {tabs.map((item) => (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              className="rounded-nkc px-2 py-2 font-semibold text-nkc-muted data-[state=active]:bg-nkc-panel data-[state=active]:text-nkc-text"
            >
              {item.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="about" className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-hidden">
          {conversation ? (
            <div className="space-y-4 rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4">
              <div className="flex items-center gap-3">
                <Avatar name={aboutAvatarName} avatarRef={aboutAvatarRef} size={52} />
                <div>
                  <div className="text-sm font-semibold text-nkc-text">
                    {displayName || conversation.name}
                  </div>
                  <div className="text-xs text-nkc-muted">상태: {detail?.status || "활성"}</div>
                </div>
              </div>
              <div className="text-xs text-nkc-muted">마지막 활동: {detail?.lastSeen || "최근"}</div>
              <div className="text-xs text-nkc-muted">
                {detail?.note || "대화 정보가 여기에 표시됩니다."}
              </div>
              <div className="space-y-2 text-xs text-nkc-muted">
                <div className="flex items-center justify-between gap-2">
                  <span>Peer ID</span>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-nkc-text">{peerIdDisplay}</span>
                    <button
                      type="button"
                      onClick={() => handleCopyValue(peerIdValue)}
                      className="rounded-nkc border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted hover:bg-nkc-panel"
                    >
                      복사
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Identity Key Fingerprint</span>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-nkc-text">{identityKeyDisplay}</span>
                    <button
                      type="button"
                      onClick={() => handleCopyValue(identityKeyValue)}
                      className="rounded-nkc border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted hover:bg-nkc-panel"
                    >
                      복사
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Trust Status</span>
                  <span className="text-nkc-text">{trustLabel}</span>
                </div>
              </div>

              {isGroup ? (
                <>
                  <div className="border-t border-nkc-border pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-nkc-muted">그룹 이미지 (나만)</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel"
                        >
                          변경
                        </button>
                        {hasOverride ? (
                          <button
                            type="button"
                            onClick={() => onSetGroupAvatarOverride(conversation.id, null)}
                            className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-muted hover:bg-nkc-panel"
                          >
                            해제
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleOverrideChange}
                    />
                    {hasOverride ? (
                      <div className="mt-1 text-[11px] text-nkc-muted">
                        이 설정은 내 기기에서만 보입니다.
                      </div>
                    ) : null}
                  </div>

                  <div className="border-t border-nkc-border pt-3">
                    <div className="text-xs font-semibold text-nkc-muted">Members ({members.length})</div>
                    <div className="mt-2 space-y-1">
                      {members.map((member) => (
                        <div key={member.id} className="flex items-center gap-2 rounded-nkc px-1 py-1.5">
                          <Avatar name={member.name} avatarRef={member.avatarRef} size={28} />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-nkc-text line-clamp-1">
                              {member.name}
                            </div>
                            {member.status ? (
                              <div className="text-[11px] text-nkc-muted line-clamp-1">{member.status}</div>
                            ) : null}
                          </div>
                          {member.isSelf ? (
                            <span className="ml-auto rounded-full border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted">
                              나
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onInviteToGroup(conversation.id)}
                      className="flex flex-1 items-center justify-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panel"
                    >
                      <UserPlus size={14} />
                      Invite
                    </button>
                    <button
                      type="button"
                      onClick={() => onLeaveGroup(conversation.id)}
                      className="flex flex-1 items-center justify-center gap-2 rounded-nkc border border-red-500/40 px-3 py-2 text-xs text-red-200 hover:bg-red-500/10"
                    >
                      <UserX size={14} />
                      Leave
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-sm text-nkc-muted">
              대화를 선택하면 상세 정보가 표시됩니다.
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="media" className="mt-4 flex min-h-0 flex-1 flex-col">
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-nkc bg-nkc-panelMuted p-1 text-xs">
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
                      ? "flex-1 rounded-nkc bg-nkc-panel px-2 py-1 font-semibold text-nkc-text"
                      : "flex-1 rounded-nkc px-2 py-1 font-semibold text-nkc-muted hover:text-nkc-text"
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hidden">
            {mediaLoading ? (
              <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-xs text-nkc-muted">
                미디어를 불러오는 중...
              </div>
            ) : mediaError ? (
              <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-xs text-nkc-muted">
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
                            className="w-full overflow-hidden rounded-nkc border border-nkc-border bg-nkc-panelMuted p-3 text-left text-xs hover:bg-nkc-panel"
                          >
                            <div className="mb-2 flex items-center justify-between">
                              <div className="font-semibold text-nkc-text">
                                {group.items.length}장
                              </div>
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
                                    className="min-w-0 rounded-nkc border border-nkc-border bg-nkc-panelMuted p-1"
                                  >
                                    {previewUrl && isImage ? (
                                      <img
                                        src={previewUrl}
                                        alt={item.media.name || "preview"}
                                        className="h-16 w-full rounded-nkc object-cover"
                                      />
                                    ) : previewUrl && isVideo ? (
                                      <video
                                        src={previewUrl}
                                        className="h-16 w-full rounded-nkc object-cover"
                                        muted
                                        playsInline
                                      />
                                    ) : (
                                      <div className="flex h-16 items-center justify-center text-[10px] text-nkc-muted">
                                        미리보기 없음
                                      </div>
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
                              <div className="mt-2 text-[11px] text-red-200">{failed}</div>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-nkc border border-dashed border-nkc-border p-4 text-xs text-nkc-muted">
                표시할 미디어가 없습니다.
              </div>
            )}
          </div>
          {viewerGroup ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="relative w-full max-w-3xl rounded-nkc bg-nkc-panel p-4 shadow-soft">
                <button
                  type="button"
                  onClick={closeViewer}
                  className="absolute right-4 top-4 rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                >
                  닫기
                </button>
                <div className="flex items-center justify-between text-xs text-nkc-muted pr-10">
                  <span className="line-clamp-1">
                    {viewerGroup.items[viewerIndex]?.media.name || "미디어"}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-center">
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
                          className="max-h-[60vh] w-full rounded-nkc object-contain"
                        />
                      );
                    }
                    if (previewUrl && isVideo) {
                      return (
                        <video
                          src={previewUrl}
                          className="max-h-[60vh] w-full rounded-nkc object-contain"
                          controls
                          playsInline
                        />
                      );
                    }
                    return (
                      <div className="flex h-[40vh] w-full items-center justify-center text-sm text-nkc-muted">
                        미리보기를 불러오는 중...
                      </div>
                    );
                  })()}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setViewerIndex((prev) => Math.max(0, prev - 1))
                      }
                      disabled={viewerIndex === 0}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                    >
                      이전
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setViewerIndex((prev) => Math.min(viewerGroup.items.length - 1, prev + 1))
                      }
                      disabled={viewerIndex >= viewerGroup.items.length - 1}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted disabled:opacity-50"
                    >
                      다음
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const item = viewerGroup.items[viewerIndex];
                        if (item) void handleDownloadItem(item);
                      }}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                    >
                      현재 장 다운로드
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadGroup(viewerGroup)}
                      className="rounded-nkc border border-nkc-border px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-panelMuted"
                    >
                      전체 다운로드
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex justify-center">
                  <span className="rounded-full border border-nkc-border bg-nkc-panelMuted px-3 py-1 text-[11px] text-nkc-muted">
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
                        className={`h-16 w-20 rounded-nkc border ${
                          idx === viewerIndex ? "border-nkc-text" : "border-nkc-border"
                        }`}
                      >
                        {previewUrl && isImage ? (
                          <img
                            src={previewUrl}
                            alt={item.media.name || "thumb"}
                            className="h-full w-full rounded-nkc object-cover"
                          />
                        ) : previewUrl && isVideo ? (
                          <video
                            src={previewUrl}
                            className="h-full w-full rounded-nkc object-cover"
                            muted
                            playsInline
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

        <Tabs.Content value="settings" className="mt-4 flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-hidden">
          <div className="space-y-3 rounded-nkc border border-nkc-border bg-nkc-panelMuted p-4 text-xs text-nkc-muted">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-nkc-text">Notifications</div>
                <div className="text-[11px]">{conversation?.muted ? "알림 꺼짐" : "알림 켜짐"}</div>
              </div>
              <button
                type="button"
                onClick={() => conversation && onToggleMute(conversation.id)}
                disabled={!conversation}
                className="rounded-nkc border border-nkc-border px-3 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel disabled:opacity-50"
              >
                {conversation?.muted ? "알림 켜기" : "알림 끄기"}
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-nkc-border pt-3">
              <div>
                <div className="font-semibold text-nkc-text">Pin</div>
                <div className="text-[11px]">{conversation?.pinned ? "고정됨" : "고정 안 됨"}</div>
              </div>
              <button
                type="button"
                onClick={() => conversation && onTogglePin(conversation.id)}
                disabled={!conversation}
                className="rounded-nkc border border-nkc-border px-3 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel disabled:opacity-50"
              >
                {conversation?.pinned ? "고정 해제" : "고정"}
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-nkc-border pt-3">
              <div className="font-semibold text-nkc-text">Conversation</div>
              <button
                type="button"
                onClick={() => conversation && onHideConversation(conversation.id)}
                disabled={!conversation}
                className="rounded-nkc border border-nkc-border px-3 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel disabled:opacity-50"
              >
                채팅 숨기기
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-nkc-border pt-3">
              <div>
                <div className="font-semibold text-nkc-text">Block</div>
                <div className="text-[11px]">{conversation?.blocked ? "차단됨" : "차단 안 됨"}</div>
              </div>
              <button
                type="button"
                onClick={() => conversation && onToggleBlock(conversation.id)}
                disabled={!conversation}
                className="rounded-nkc border border-nkc-border px-3 py-1 text-[11px] text-nkc-text hover:bg-nkc-panel disabled:opacity-50"
              >
                {conversation?.blocked ? "차단 해제" : "차단"}
              </button>
            </div>
          </div>
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center justify-center gap-2 rounded-nkc border border-nkc-border px-3 py-2 text-xs text-nkc-text hover:bg-nkc-panelMuted"
          >
            <Settings size={14} />
            전체 설정 열기
          </button>
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}





















