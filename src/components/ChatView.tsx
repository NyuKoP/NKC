import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useCallback } from "react";
import { useAppStore } from "../app/store";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  FileText,
  PanelRight,
  Paperclip,
  Search,
} from "lucide-react";
import type { Conversation, MediaRef, Message, UserProfile } from "../db/repo";
import { loadMessageMedia } from "../db/repo";
import type { ConversationTransportStatus } from "../net/transportManager";
import { getOutbox } from "../storage/outboxStore";
import { getReadCursors, getReceiptState } from "../storage/receiptStore";
import { getPrivacyPrefs, PRIVACY_PREFS_CHANGED_EVENT } from "../security/preferences";
import Avatar from "./Avatar";
import MessageGroupBubble, { type ChatMessageLike } from "./MessageGroupBubble";
import { groupMessages, type MessageGroup } from "../ui/groupMessages";
import {
  MESSAGE_DELIVERY_LABELS,
  resolveMessageDeliveryStatus,
  type MessageDeliveryStatus,
} from "../ui/messageDeliveryStatus";

const EMPTY_ARRAY: Message[] = [];

const MAX_ATTACH_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_ATTACH_IMAGE_COUNT = 30;
const MAX_ATTACH_TOTAL_COUNT = 30;

const computeAttachmentTotals = (files: File[]) => {
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const imageCount = files.reduce(
    (sum, file) => sum + (file.type?.startsWith("image/") ? 1 : 0),
    0
  );
  const totalCount = files.length;
  return { totalBytes, imageCount, totalCount };
};

const validateAttachmentTotals = (files: File[]) => {
  const oversized = files.find((file) => (file.size || 0) > MAX_ATTACH_TOTAL_BYTES);
  if (oversized) {
    window.alert("단일 첨부는 500MB를 초과할 수 없습니다.");
    return false;
  }
  const { totalBytes, imageCount, totalCount } = computeAttachmentTotals(files);
  if (totalCount > MAX_ATTACH_TOTAL_COUNT) {
    window.alert(`첨부는 한 번에 최대 ${MAX_ATTACH_TOTAL_COUNT}개까지 가능합니다.`);
    return false;
  }
  if (imageCount > MAX_ATTACH_IMAGE_COUNT) {
    window.alert(`사진은 한 번에 최대 ${MAX_ATTACH_IMAGE_COUNT}장까지 가능합니다.`);
    return false;
  }
  if (totalBytes > MAX_ATTACH_TOTAL_BYTES) {
    window.alert("첨부 총 용량은 500MB를 초과할 수 없습니다.");
    return false;
  }
  return true;
};

const formatTime = (ts: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

const formatDate = (ts: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
  }).format(new Date(ts));

type ChatViewProps = {
  conversation: Conversation | null;
  conversationDisplayName?: string;
  transportStatus?: ConversationTransportStatus | null;
  currentUserId: string | null;
  nameMap: Record<string, string>;
  profilesById: Record<string, UserProfile | undefined>;
  isComposing: boolean;
  onComposingChange: (value: boolean) => void;
  onSendBatch: (payload: { text: string; files: File[] }) => void;
  onSendReadReceipt?: (payload: { convId: string; msgId: string; msgTs: number }) => void;
  onAcceptRequest?: () => void;
  onDeclineRequest?: () => void;
  onCancelOutgoingRequest?: () => void;
  onBack: () => void;
  onToggleRight: () => void;
  rightPanelOpen: boolean;
  onDeleteMessages?: (payload: { convId: string; messageIds: string[] }) => void;
  onToast?: (message: string) => void;
};

export default function ChatView({
  conversation,
  conversationDisplayName,
  transportStatus,
  currentUserId,
  nameMap,
  profilesById,
  isComposing,
  onComposingChange,
  onSendBatch,
  onSendReadReceipt,
  onAcceptRequest,
  onDeclineRequest,
  onCancelOutgoingRequest,
  onBack,
  onToggleRight,
  rightPanelOpen,
  onDeleteMessages,
  onToast,
}: ChatViewProps) {
  const messages = useAppStore((state) =>
    conversation ? state.messagesByConv[conversation.id] || EMPTY_ARRAY : EMPTY_ARRAY
  );
  const [atBottom, setAtBottom] = useState(true);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(false);
  const [sendStates, setSendStates] = useState<Record<string, MessageDeliveryStatus>>({});
  const [readCursors, setReadCursors] = useState<Record<string, number>>({});
  const [copiedFriendCode, setCopiedFriendCode] = useState<string | null>(null);
  const [safetyTipsOpen, setSafetyTipsOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const latestIncomingRef = useRef<HTMLDivElement | null>(null);
  const [messageMenu, setMessageMenu] = useState<{
    group: MessageGroup<ChatMessageLike>;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isGroup = Boolean(
    conversation && (conversation.type === "group" || conversation.participants.length > 2)
  );
  const chatColumnClass = rightPanelOpen
    ? "max-w-[clamp(760px,65vw,980px)]"
    : "max-w-[clamp(920px,85vw,1320px)]";
  const [isWindowActive, setIsWindowActive] = useState(() => {
    if (typeof document === "undefined") return true;
    const visible = document.visibilityState === "visible";
    const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    return visible && focused;
  });

  const openMessageMenu = useCallback(
    (group: MessageGroup<ChatMessageLike>, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 180;
      const menuHeight = 100;
      const padding = 8;
      const x = Math.min(event.clientX, window.innerWidth - menuWidth - padding);
      const y = Math.min(event.clientY, window.innerHeight - menuHeight - padding);
      setMessageMenu({ group, x, y });
    },
    []
  );

  const handleCopyGroup = useCallback(
    async (group: MessageGroup<ChatMessageLike>) => {
      const textParts = group.items
        .filter((item) => item.kind === "text" && item.text)
        .map((item) => item.text.trim())
        .filter(Boolean);
      const mediaParts = group.items
        .filter((item) => item.kind === "media" && item.media)
        .map((item) => item.media?.name || "")
        .filter(Boolean);
      const payload = [...textParts, ...mediaParts].join("\n").trim();
      if (!payload) {
        onToast?.("복사할 내용이 없습니다.");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = payload;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        onToast?.("복사했습니다.");
      } catch (error) {
        console.error("Failed to copy message", error);
        onToast?.("복사에 실패했습니다.");
      }
    },
    [onToast]
  );

  useEffect(() => {
    if (!messageMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return;
      setMessageMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMessageMenu(null);
    };
    const handleScroll = () => setMessageMenu(null);
    window.addEventListener("click", handleClick);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [messageMenu]);

  const peerProfile = useMemo(() => {
    if (!conversation || !currentUserId || isGroup) return null;
    const partnerId = conversation.participants.find((id) => id !== currentUserId);
    return partnerId ? profilesById[partnerId] ?? null : null;
  }, [conversation, currentUserId, isGroup, profilesById]);

  const requestIncoming =
    !isGroup &&
    (Boolean(conversation?.pendingAcceptance) || peerProfile?.friendStatus === "request_in");
  const requestOutgoing = !isGroup && peerProfile?.friendStatus === "request_out";
  const pendingTextOnly = requestIncoming || requestOutgoing;
  const pendingFriendCode = peerProfile?.profileVcard?.friendCode;
  const codeCopied = Boolean(pendingFriendCode && copiedFriendCode === pendingFriendCode);
  const pendingSenderName = peerProfile
    ? nameMap[peerProfile.id] || peerProfile.displayName || "알 수 없음"
    : "알 수 없음";
  const [viewerGroup, setViewerGroup] = useState<ChatMessageLike[] | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerUrls, setViewerUrls] = useState<Record<string, string>>({});
  const [viewerBusy, setViewerBusy] = useState<Record<string, boolean>>({});
  const viewerRunRef = useRef(0);
  const viewerUrlsRef = useRef<Record<string, string>>({});
  const viewerBusyRef = useRef<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const groupedBatches = useMemo(() => {
    const items: ChatMessageLike[] = messages.map((message) => ({
      ...message,
      createdAt: message.ts,
      kind: message.media ? "media" : "text",
    }));
    return groupMessages(items);
  }, [messages]);
  const renderGroups = useMemo(() => {
    const results: Array<{
      group: MessageGroup<ChatMessageLike>;
      dateLabel?: string;
      showSender: boolean;
    }> = [];
    let lastDate = "";
    let lastSender: string | null = null;
    groupedBatches.forEach((group) => {
      const dateLabel = formatDate(group.createdAt);
      const isNewDate = dateLabel !== lastDate;
      if (isNewDate) {
        lastDate = dateLabel;
        lastSender = null;
      }
      const isMine = group.senderId === currentUserId;
      const showSender = !isMine && group.senderId !== lastSender;
      if (!isMine) {
        lastSender = group.senderId;
      }
      results.push({
        group,
        dateLabel: isNewDate ? dateLabel : undefined,
        showSender,
      });
    });
    return results;
  }, [currentUserId, groupedBatches]);
  const latestIncoming = useMemo(() => {
    if (!conversation || !currentUserId) return null;
    return (
      [...messages].reverse().find((message) => message.senderId !== currentUserId) ?? null
    );
  }, [conversation, currentUserId, messages]);
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return messages
      .filter((message) => message.text?.toLowerCase().includes(query))
      .map((message) => message.id);
  }, [messages, searchQuery]);

  useEffect(() => {
    viewerUrlsRef.current = viewerUrls;
  }, [viewerUrls]);

  useEffect(() => {
    viewerBusyRef.current = viewerBusy;
  }, [viewerBusy]);

  const clearViewerPreviews = useCallback(() => {
    viewerRunRef.current += 1;
    setViewerUrls((prev) => {
      Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });
    setViewerBusy({});
  }, []);

  const openViewer = useCallback(
    (items: ChatMessageLike[], index: number) => {
      clearViewerPreviews();
      setViewerGroup(items);
      setViewerIndex(index);
    },
    [clearViewerPreviews]
  );

  const closeViewer = useCallback(() => {
    clearViewerPreviews();
    setViewerGroup(null);
    setViewerIndex(0);
  }, [clearViewerPreviews]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
  }, [closeSearch, searchOpen]);

  useEffect(() => {
    if (!viewerGroup?.length) return;
    const runId = (viewerRunRef.current += 1);
    const load = async () => {
      for (const message of viewerGroup) {
        const media = message.media;
        if (!media || !isPreviewableMedia(media)) continue;
        if (viewerUrlsRef.current[message.id]) continue;
        if (viewerBusyRef.current[message.id]) continue;
        setViewerBusy((prev) => ({ ...prev, [message.id]: true }));
        const blob = await loadMessageMedia(media);
        if (runId !== viewerRunRef.current) return;
        if (!blob) {
          setViewerBusy((prev) => {
            const next = { ...prev };
            delete next[message.id];
            return next;
          });
          continue;
        }
        const url = URL.createObjectURL(blob);
        setViewerUrls((prev) => ({ ...prev, [message.id]: url }));
        setViewerBusy((prev) => {
          const next = { ...prev };
          delete next[message.id];
          return next;
        });
      }
    };
    void load();
  }, [viewerGroup]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyFriendCode = useCallback(async () => {
    if (!pendingFriendCode) return;
    try {
      await navigator.clipboard.writeText(pendingFriendCode);
      setCopiedFriendCode(pendingFriendCode);
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedFriendCode(null);
      }, 1500);
    } catch (error) {
      console.warn("Failed to copy friend code", error);
      onToast?.("복사에 실패했습니다.");
    }
  }, [onToast, pendingFriendCode]);

  useEffect(() => {
    return () => {
      Object.values(viewerUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    if (!searchInputRef.current) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSearch, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!searchMatches.length) return;
    const targetId = searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    if (!targetId) return;
    const target = timelineRef.current?.querySelector(
      `[data-msg-id="${targetId}"]`
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [searchIndex, searchMatches, searchOpen]);

  useEffect(() => {
    let active = true;
    const handlePrivacyChange = (event: Event) => {
      const prefs = (event as CustomEvent<{ readReceipts?: boolean }>).detail;
      setReadReceiptsEnabled(Boolean(prefs?.readReceipts));
    };
    window.addEventListener(PRIVACY_PREFS_CHANGED_EVENT, handlePrivacyChange);
    void getPrivacyPrefs()
      .then((prefs) => {
        if (active) setReadReceiptsEnabled(Boolean(prefs.readReceipts));
      })
      .catch(() => {
        if (active) setReadReceiptsEnabled(false);
      });
    return () => {
      active = false;
      window.removeEventListener(PRIVACY_PREFS_CHANGED_EVENT, handlePrivacyChange);
    };
  }, [conversation]);

  const refreshSendStates = useCallback(async () => {
    if (!currentUserId) {
      setSendStates({});
      return;
    }
    const ownMessages = messages.filter((message) => typeof message.id === "string" && message.senderId === currentUserId);
    if (!ownMessages.length) {
      setSendStates({});
      return;
    }
    const entries = await Promise.all(
      ownMessages.map(async (message) => {
        const [outbox, receiptState] = await Promise.all([
          getOutbox(message.id),
          getReceiptState(message.id),
        ]);
        const readByPeerCursor = Object.entries(readCursors).some(
          ([actorId, cursorTs]) =>
            actorId !== currentUserId && Number.isFinite(cursorTs) && cursorTs >= message.ts
        );
        const state = resolveMessageDeliveryStatus({
          outboxStatus: outbox?.status,
          delivered: receiptState.delivered,
          read: receiptState.read || readByPeerCursor,
          readReceiptsEnabled,
        });
        return [message.id, state] as const;
      })
    );
    setSendStates(Object.fromEntries(entries));
  }, [currentUserId, messages, readCursors, readReceiptsEnabled]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await refreshSendStates();
    };
    void run();
    const timer = window.setInterval(() => {
      void refreshSendStates();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshSendStates]);

  const refreshReadCursors = useCallback(async () => {
    if (!conversation) {
      setReadCursors({});
      return;
    }
    const next = await getReadCursors(conversation.id);
    setReadCursors(next);
  }, [conversation]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await refreshReadCursors();
    };
    void run();
    const timer = window.setInterval(() => {
      void refreshReadCursors();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshReadCursors]);

  useEffect(() => {
    if (!conversation) return;
    const updateWindowActive = () => {
      const visible = document.visibilityState === "visible";
      const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
      setIsWindowActive(visible && focused);
    };
    updateWindowActive();
    window.addEventListener("focus", updateWindowActive);
    window.addEventListener("blur", updateWindowActive);
    document.addEventListener("visibilitychange", updateWindowActive);
    return () => {
      window.removeEventListener("focus", updateWindowActive);
      window.removeEventListener("blur", updateWindowActive);
      document.removeEventListener("visibilitychange", updateWindowActive);
    };
  }, [conversation]);

  useEffect(() => {
    if (!conversation || !currentUserId || !readReceiptsEnabled || !onSendReadReceipt) return;
    if (requestIncoming) return;
    if (!latestIncoming) return;
    if (!isWindowActive) return;

    const sendReceipt = async () => {
      const state = await getReceiptState(latestIncoming.id);
      if (state.read) return;
      const ownCursor = readCursors[currentUserId] ?? 0;
      if (ownCursor >= latestIncoming.ts) return;
      await onSendReadReceipt({
        convId: conversation.id,
        msgId: latestIncoming.id,
        msgTs: latestIncoming.ts,
      });
    };

    const root = timelineRef.current;
    const target = latestIncomingRef.current;
    if (!target) return;

    if (typeof IntersectionObserver === "undefined") {
      void sendReceipt();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void sendReceipt();
      },
      {
        root,
        threshold: 0.6,
      }
    );

    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [
    conversation,
    currentUserId,
    isWindowActive,
    latestIncoming,
    onSendReadReceipt,
    readCursors,
    readReceiptsEnabled,
    requestIncoming,
  ]);

  useEffect(() => {
    if (conversation) {
      if (atBottom) {
        requestAnimationFrame(() => scrollToBottom(timelineRef.current));
      }
    }
  }, [messages.length, conversation, atBottom]);

  useEffect(() => {
    if (conversation) {
      requestAnimationFrame(() => scrollToBottom(timelineRef.current));
    }
  }, [conversation]);

  const handleScroll = () => {
    if (!timelineRef.current) return;
    const el = timelineRef.current;
    const threshold = 48;
    const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    setAtBottom(isBottom);
  };

  const transportLabel =
    transportStatus?.kind === "direct"
      ? "Direct"
      : transportStatus?.kind === "onion"
        ? "Onion"
        : null;

  const renderSendState = (state?: MessageDeliveryStatus) => {
    if (!state) return null;
    const label = MESSAGE_DELIVERY_LABELS[state];
    const icon =
      state === "queued" ? (
        <Clock size={13} aria-hidden="true" />
      ) : state === "sent" ? (
        <Check size={13} aria-hidden="true" />
      ) : (
        <CheckCheck size={13} aria-hidden="true" />
      );
    return (
      <span
        className={`inline-flex items-center ${state === "read" ? "text-[#e5faff]" : "text-white"}`}
        role="img"
        aria-label={`${label.ko} (${label.en})`}
        title={`${label.ko} (${label.en})`}
        data-message-delivery-status={state}
      >
        {icon}
      </span>
    );
  };

  const goToSearchResult = (direction: 1 | -1) => {
    if (!searchMatches.length) return;
    setSearchIndex((prev) => {
      const next = (prev + direction + searchMatches.length) % searchMatches.length;
      return next;
    });
  };

  const participants = conversation?.participants ?? [];
  const totalOthers = currentUserId
    ? participants.filter((id) => id && id !== currentUserId).length
    : 0;

  const getSeenInfo = (message: Message) => {
    if (!conversation || !currentUserId || !readReceiptsEnabled) return null;
    if (message.senderId !== currentUserId) return null;
    if (totalOthers <= 0) return null;
    let seenCount = 0;
    Object.entries(readCursors).forEach(([actorId, cursorTs]) => {
      if (actorId === currentUserId) return;
      if (!Number.isFinite(cursorTs)) return;
      if (cursorTs >= message.ts) {
        seenCount += 1;
      }
    });
    return { seenCount, totalOthers };
  };

  return (
    <section
      className="flex h-full flex-1 flex-col bg-nkc-bg"
      data-testid="chat-view"
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!conversation || requestIncoming || requestOutgoing) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return;
        window.dispatchEvent(new CustomEvent("nkc:attach-files", { detail: { files } }));
      }}
    >
      {conversation ? (
      <header className="flex min-h-[64px] items-center justify-between border-b border-nkc-border bg-nkc-panel px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text lg:hidden"
            aria-label="대화 목록으로 돌아가기"
          >
            <ArrowLeft size={16} />
          </button>
          {conversation ? (
            <Avatar
              name={conversationDisplayName || conversation.name}
              colorKey={isGroup ? conversation.id : peerProfile?.id ?? conversation.id}
              avatarRef={peerProfile?.avatarRef}
              size={36}
            />
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[15px] font-semibold text-nkc-text line-clamp-1">
                {conversation
                  ? conversationDisplayName || conversation.name
                  : "대화를 선택하세요"}
              </div>
              {conversation && transportLabel ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                    transportStatus?.kind === "direct"
                      ? "border-red-400/30 text-red-400 bg-red-500/10"
                      : "border-nkc-border text-nkc-muted"
                  }`}
                >
                  {transportStatus?.kind === "direct" ? <AlertTriangle size={12} /> : null}
                  {transportLabel}
                </span>
              ) : null}
              {conversation && requestOutgoing ? (
                <span className="inline-flex items-center rounded-full border border-nkc-border px-2 py-1 text-[11px] text-nkc-muted">
                  초대됨
                </span>
              ) : null}
            </div>
            <div className="text-xs text-nkc-muted line-clamp-1">
              {conversation ? "마지막 활동 2분 전" : "왼쪽에서 대화를 선택하세요"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSearch}
            className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            disabled={!conversation}
            aria-label="채팅 검색"
          >
            <Search size={14} />
          </button>
          <button
            onClick={onToggleRight}
            className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            disabled={!conversation}
            aria-label={rightPanelOpen ? "정보 닫기" : "대화 정보"}
          >
            <PanelRight size={16} />
          </button>
        </div>
      </header>
      ) : null}
      {searchOpen && conversation ? (
        <div className="border-b border-nkc-border bg-nkc-bg px-4 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-nkc-muted">
            <div className="flex flex-1 items-center gap-2 rounded-full bg-nkc-hover px-3 py-1.5">
              <Search size={12} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    goToSearchResult(event.shiftKey ? -1 : 1);
                  }
                  if (event.key === "Escape") {
                    closeSearch();
                  }
                }}
                placeholder="채팅 기록 검색"
                className="w-full bg-transparent text-xs text-nkc-text placeholder:text-nkc-muted focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              {searchQuery.trim() && searchMatches.length === 0 ? (
                <span className="rounded-full border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted">
                  없음
                </span>
              ) : null}
              <span>
                {searchMatches.length
                  ? `${Math.min(searchIndex + 1, searchMatches.length)}/${searchMatches.length}`
                  : "0/0"}
              </span>
              <button
                type="button"
                onClick={() => goToSearchResult(-1)}
                disabled={!searchMatches.length}
                className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover disabled:opacity-40"
              >
                이전
              </button>
              <button
                type="button"
                onClick={() => goToSearchResult(1)}
                disabled={!searchMatches.length}
                className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover disabled:opacity-40"
              >
                다음
              </button>
              <button
                type="button"
                onClick={closeSearch}
                className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={timelineRef}
        onScroll={handleScroll}
        className="scrollbar-hidden relative flex-1 overflow-y-auto bg-nkc-bg"
      >
        {conversation ? (
          <div className="ml-auto mr-0 flex w-full max-w-[min(100%,1800px)] flex-col gap-4 px-8 py-6">
            {requestIncoming ? (
              <div className="-mx-8 -mt-6 border-b border-nkc-border px-6 py-6 text-center" data-testid="message-request-profile">
                <Avatar
                  name={pendingSenderName}
                  colorKey={peerProfile?.id ?? conversation.id}
                  avatarRef={peerProfile?.avatarRef}
                  size={72}
                  className="mx-auto"
                />
                <div className="mt-3 text-lg font-semibold text-nkc-text">{pendingSenderName}</div>
                <div className="mt-1 text-xs text-nkc-muted">새 연락처의 메시지 요청</div>
                <button
                  type="button"
                  onClick={() => setSafetyTipsOpen((open) => !open)}
                  className="mt-3 rounded-full bg-nkc-hover px-4 py-2 text-xs font-semibold text-nkc-text hover:bg-nkc-selected"
                  aria-expanded={safetyTipsOpen}
                >
                  안전 팁
                </button>
                {safetyTipsOpen ? (
                  <div className="mx-auto mt-4 max-w-lg rounded-xl border border-nkc-border bg-nkc-panelMuted p-4 text-left text-xs leading-5 text-nkc-muted" data-testid="message-request-safety-tips">
                    <ul className="list-disc space-y-1 pl-4">
                      <li>표시 이름과 프로필 사진만으로 상대의 신원을 확인할 수 없습니다.</li>
                      <li>아는 사람이 맞는지 다른 연락 수단으로 먼저 확인하세요.</li>
                      <li>시작 키, PIN 또는 개인 키는 누구에게도 공유하지 마세요.</li>
                    </ul>
                    {pendingFriendCode ? (
                      <div className="mt-3 flex min-w-0 items-center gap-2 border-t border-nkc-border pt-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-nkc-text">{pendingFriendCode}</span>
                        <button
                          type="button"
                          onClick={handleCopyFriendCode}
                          className="shrink-0 rounded-lg px-2 py-1 font-semibold text-nkc-accent hover:bg-nkc-hover"
                        >
                          {codeCopied ? "복사됨" : "코드 복사"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {requestOutgoing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-nkc-surface px-4 py-3 text-sm">
                <div className="space-y-1">
                  <div className="text-nkc-text">친구 요청을 보냈습니다.</div>
                  <div className="text-xs text-nkc-muted">
                    상대가 수락하면 바로 대화를 시작할 수 있습니다.
                  </div>
                </div>
                {onCancelOutgoingRequest ? (
                  <button
                    type="button"
                    onClick={onCancelOutgoingRequest}
                    className="rounded-lg px-3 py-1.5 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
                  >
                    친구추가요청 취소
                  </button>
                ) : null}
              </div>
            ) : null}
            {renderGroups.map(({ group, dateLabel, showSender }) => {
              const senderProfile = profilesById[group.senderId];
              const senderName =
                group.senderId === currentUserId
                  ? "나"
                  : nameMap[group.senderId] || senderProfile?.displayName || "알 수 없음";
              const isSystem = group.senderId === "system";
              const lastMessage = group.items.reduce((latest, item) =>
                item.ts > latest.ts ? item : latest
              );
              const seenInfo = getSeenInfo(lastMessage);
              const isLatestIncoming =
                latestIncoming &&
                currentUserId &&
                group.senderId !== currentUserId &&
                group.items.some((item) => item.id === latestIncoming.id);
              return (
                <div key={group.key} className="space-y-2">
                  {dateLabel ? (
                    <div className="flex justify-center">
                      <span className="rounded-full bg-nkc-surface/80 px-3 py-1 text-[11px] font-medium text-nkc-muted">
                        {dateLabel}
                      </span>
                    </div>
                  ) : null}
                  {isSystem ? (
                    <div className="flex justify-center">
                      <span className="rounded-full bg-nkc-surface/80 px-3 py-1 text-[11px] text-nkc-muted">
                        {group.items.map((item) => item.text).filter(Boolean).join(" ")}
                      </span>
                    </div>
                  ) : null}
                  {isSystem ? null : (
                  <div
                    className={`flex gap-3 ${
                      group.senderId === currentUserId ? "justify-end" : "justify-start"
                    }`}
                  >
                    {group.senderId !== currentUserId ? (
                      <Avatar
                        name={senderName}
                        colorKey={group.senderId}
                        avatarRef={senderProfile?.avatarRef}
                        size={32}
                        className="mt-1"
                      />
                    ) : null}
                    <div className={`flex ${chatColumnClass} flex-col gap-2`}>
                      {group.senderId !== currentUserId && showSender ? (
                        <span className="text-xs text-nkc-muted">{senderName}</span>
                      ) : null}
                      <div ref={isLatestIncoming ? latestIncomingRef : undefined}>
                        <MessageGroupBubble
                          group={group}
                          isMine={group.senderId === currentUserId}
                          onOpenMedia={openViewer}
                          onRequestMenu={(event) => openMessageMenu(group, event)}
                          highlightQuery={searchOpen ? searchQuery : ""}
                          footer={
                            <>
                              <span>{formatTime(lastMessage.ts)}</span>
                              {group.senderId === currentUserId && seenInfo && isGroup ? (
                                seenInfo.totalOthers > 0 &&
                                seenInfo.seenCount >= seenInfo.totalOthers ? (
                                  <span className="ml-1">읽음</span>
                                ) : null
                              ) : null}
                              {group.senderId === currentUserId
                                ? renderSendState(sendStates[lastMessage.id])
                                : null}
                            </>
                          }
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              );
            })}
            {requestIncoming ? (
              <div className="mx-auto mt-2 w-full max-w-2xl border-t border-nkc-border pt-5 text-center" data-testid="message-request-actions">
                <div className="text-sm font-semibold text-amber-600">
                  신중하게 메시지 요청을 검토하세요
                </div>
                <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-nkc-muted">
                  {pendingSenderName}님이 처음 메시지를 보냈습니다. 수락하기 전까지 상대방은 읽음 여부를 확인할 수 없으며, 메시지 전송도 제한됩니다.
                </p>
                <div className="mt-4 flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={onDeclineRequest}
                    className="min-w-28 rounded-full bg-nkc-hover px-5 py-2 text-sm font-semibold text-red-500 hover:bg-red-500/10"
                  >
                    차단
                  </button>
                  <button
                    type="button"
                    onClick={onAcceptRequest}
                    className="min-w-28 rounded-full bg-nkc-accent px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
                  >
                    수락
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="relative flex h-full flex-col items-center justify-center gap-2 px-6 pb-12 text-center text-nkc-muted">
            <div
              className="mb-3 h-24 w-24 bg-nkc-accent"
              aria-label="NKC"
              role="img"
              style={{
                WebkitMaskImage: 'url("./nkc-n-mark.png")',
                WebkitMaskPosition: "center",
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
                maskImage: 'url("./nkc-n-mark.png")',
                maskPosition: "center",
                maskRepeat: "no-repeat",
                maskSize: "contain",
              }}
            >
            </div>
            <div className="text-lg font-semibold text-nkc-text">NKC에 오신 것을 환영합니다</div>
            <div className="max-w-sm text-sm leading-6">
              친구를 추가하거나 왼쪽에서 대화를 선택해 시작하세요.
            </div>
            <div className="absolute bottom-6 text-xs text-nkc-muted">
              NKC의 대화는 종단간 암호화됩니다.
            </div>
          </div>
        )}

        {!atBottom && conversation ? (
          <button
            onClick={() => scrollToBottom(timelineRef.current)}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-nkc-accent px-4 py-2 text-xs font-medium text-white"
          >
            <ArrowDown size={12} />
            맨 아래로
          </button>
        ) : null}
      </div>

      {messageMenu ? (
        <div className="fixed inset-0 z-50">
          <div
            ref={menuRef}
            className="pointer-events-auto fixed min-w-[140px] rounded-lg border border-nkc-border bg-nkc-surface p-1 text-xs animate-signal-fade-scale"
            style={{ left: messageMenu.x, top: messageMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover"
              onClick={() => {
                void handleCopyGroup(messageMenu.group);
                setMessageMenu(null);
              }}
            >
              복사
            </button>
            {onDeleteMessages ? (
              <button
                type="button"
                className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-red-400 hover:bg-red-500/10"
                onClick={() => {
                  const convId =
                    messageMenu.group.items[0]?.convId || conversation?.id || "";
                  const messageIds = messageMenu.group.items.map((item) => item.id);
                  if (convId && messageIds.length) {
                    onDeleteMessages({ convId, messageIds });
                  }
                  setMessageMenu(null);
                }}
              >
                삭제
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {viewerGroup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-3xl rounded-xl bg-nkc-surface p-4">
            <button
              type="button"
              onClick={closeViewer}
              className="absolute right-4 top-4 rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover"
            >
              닫기
            </button>
            <div className="flex items-center justify-between text-xs text-nkc-muted pr-10">
              <span className="line-clamp-1">
                {viewerGroup[viewerIndex]?.media?.name || "미디어"}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-center">
              {(() => {
                const current = viewerGroup[viewerIndex];
                const media = current?.media;
                if (!media) return null;
                const previewUrl = viewerUrls[current.id];
                if (previewUrl) {
                  return (
                    <img
                      src={previewUrl}
                      alt={media.name}
                      className="max-h-[60vh] w-full rounded-lg object-contain"
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
                  onClick={() => setViewerIndex((prev) => Math.max(0, prev - 1))}
                  disabled={viewerIndex === 0}
                  className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover disabled:opacity-40"
                >
                  이전
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setViewerIndex((prev) =>
                      Math.min(viewerGroup.length - 1, prev + 1)
                    )
                  }
                  disabled={viewerIndex >= viewerGroup.length - 1}
                  className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover disabled:opacity-40"
                >
                  다음
                </button>
              </div>
              <span className="rounded-full bg-nkc-hover px-3 py-1 text-[11px] text-nkc-muted">
                {viewerIndex + 1}/{viewerGroup.length}
              </span>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {viewerGroup.map((message, index) => {
                const media = message.media;
                if (!media) return null;
                const previewUrl = viewerUrls[message.id];
                return (
                  <button
                    key={message.id}
                    type="button"
                    onClick={() => setViewerIndex(index)}
                    className={`h-16 w-20 rounded-md border ${
                      index === viewerIndex ? "border-nkc-text" : "border-nkc-border"
                    }`}
                  >
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt={media.name}
                        className="h-full w-full rounded-md object-cover"
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

      {conversation && !requestIncoming ? (
      <MessageComposer
        key={conversation?.id ?? "none"}
        conversation={conversation}
        disabled={false}
        textOnly={pendingTextOnly}
        isComposing={isComposing}
        onComposingChange={onComposingChange}
        onSendBatch={onSendBatch}
      />
      ) : null}
    </section>
  );
}

type MessageComposerProps = {
  conversation: Conversation | null;
  disabled?: boolean;
  textOnly?: boolean;
  isComposing: boolean;
  onComposingChange: (value: boolean) => void;
  onSendBatch: (payload: { text: string; files: File[] }) => void;
};

const MessageComposer = ({
  conversation,
  disabled = false,
  textOnly = false,
  isComposing,
  onComposingChange,
  onSendBatch,
}: MessageComposerProps) => {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previews = useMemo(
    () =>
      attachments.map((file) => ({
        file,
        url: URL.createObjectURL(file),
        isImage: file.type.startsWith("image/"),
      })),
    [attachments]
  );

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(
      textareaRef.current.scrollHeight,
      60
    )}px`;
    textareaRef.current.style.overflowY =
      textareaRef.current.scrollHeight > 60 ? "auto" : "hidden";
  }, [text]);

  const addFilesToQueue = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    setAttachments((prev) => {
      const merged = [...prev, ...incoming];
      if (!validateAttachmentTotals(merged)) return prev;
      return merged;
    });
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      if (!conversation || disabled || textOnly) return;
      const custom = event as CustomEvent<{ files?: File[] }>;
      const files = custom.detail?.files ?? [];
      addFilesToQueue(files);
    };
    window.addEventListener("nkc:attach-files", handler as EventListener);
    return () => {
      window.removeEventListener("nkc:attach-files", handler as EventListener);
    };
  }, [addFilesToQueue, conversation, disabled, textOnly]);

  const handleSend = () => {
    if (!conversation || disabled) return;
    const trimmed = text.trim();
    const hasText = Boolean(trimmed);
    const hasAttachments = attachments.length > 0;
    if (textOnly && hasAttachments) return;
    if (!hasText && !hasAttachments) return;

    onSendBatch({ text: trimmed, files: attachments });
    if (hasText) setText("");
    if (hasAttachments) setAttachments([]);
  };

  const handleMediaSelect = (event: ChangeEvent<HTMLInputElement>) => {
    if (!conversation || disabled || textOnly) return;
    const files = Array.from(event.target.files ?? []);
    addFilesToQueue(files);
    event.target.value = "";
  };

  const attachmentImageCount = attachments.filter((file) =>
    file.type?.startsWith("image/")
  ).length;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isComposing) return;
        handleSend();
      }}
      className={`border-t border-nkc-border bg-nkc-bg px-4 py-3 ${
        conversation && !disabled ? "" : "opacity-60"
      }`}
    >
      <div className="rounded-[18px] bg-nkc-hover p-3 transition-[background-color,box-shadow] duration-150 ease-out focus-within:shadow-[0_0_0_1px_var(--nkc-accent)]">
        {textOnly ? (
          <div className="mb-2 text-xs text-nkc-muted">
            요청 대기중: 텍스트만 전송할 수 있습니다.
          </div>
        ) : null}
        {attachments.length ? (
          <div className="mb-2 flex items-center justify-between text-xs text-nkc-muted">
            <span>
              첨부 {attachments.length}개 / 사진 {attachmentImageCount}장
            </span>
            <button
              type="button"
              onClick={() => setAttachments([])}
              className="text-red-200 hover:text-red-100"
            >
              첨부 취소
            </button>
          </div>
        ) : null}
        {previews.length ? (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {previews.map((preview) => (
              <div
                key={`${preview.file.name}-${preview.file.lastModified}`}
                data-testid="attachment-preview"
                className="relative h-20 w-20 flex-shrink-0 rounded-lg bg-nkc-hover"
              >
                {preview.isImage ? (
                  <img
                    src={preview.url}
                    alt={preview.file.name}
                    className="h-full w-full rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-[10px] text-nkc-muted">
                    <FileText size={16} className="text-nkc-muted" />
                    <span className="line-clamp-2 text-center">{preview.file.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((file) => file !== preview.file))
                  }
                  className="absolute right-1 top-1 rounded-full bg-nkc-surface px-1 text-[10px] text-nkc-text hover:bg-nkc-hover"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          disabled={!conversation || disabled}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => onComposingChange(true)}
          onCompositionEnd={() => onComposingChange(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              if (event.nativeEvent.isComposing || isComposing) {
                return;
              }
              event.preventDefault();
              handleSend();
            }
          }}
          className="h-auto min-h-5 max-h-[60px] w-full resize-none overflow-y-hidden bg-transparent text-sm leading-5 text-nkc-text transition-[height] duration-100 ease-out placeholder:text-nkc-muted focus:outline-none"
          placeholder="메시지를 입력하세요"
          rows={1}
          maxLength={240}
          data-testid="chat-message-input"
        />
        <div className="mt-3 flex items-center justify-between text-xs text-nkc-muted">
          <div className="flex items-center gap-3">
            <label
              className={`flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-surface hover:text-nkc-text ${
                conversation && !disabled && !textOnly ? "" : "pointer-events-none opacity-50"
              }`}
              data-testid="chat-attach-button"
            >
              <Paperclip size={14} />
              <input
                type="file"
                multiple
                accept="*/*"
                className="hidden"
                onChange={handleMediaSelect}
                disabled={!conversation || disabled || textOnly}
                data-testid="chat-attach-input"
              />
            </label>
            <span>{text.length} / 240</span>
          </div>
          <button
            type="submit"
            data-testid="chat-send-button"
            disabled={!conversation || disabled || (!text.trim() && attachments.length === 0)}
            className="rounded-full bg-nkc-accent px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30 hover:brightness-110"
          >
            전송
          </button>
        </div>
      </div>
    </form>
  );
};


const isPreviewableMedia = (media: MediaRef) => media.mime.startsWith("image/");

const scrollToBottom = (el: HTMLDivElement | null) => {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
};
