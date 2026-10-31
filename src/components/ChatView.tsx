import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { firstMessageMeasurement } from "../diagnostics/coldStartMetrics";
import { useLayoutEffect } from "react";
import { useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../app/store";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  PanelRight,
  Paperclip,
  Search,
} from "lucide-react";
import type { Conversation, MediaRef, Message, UserProfile } from "../db/repo";
import { loadMessageMedia } from "../db/repo";
import ConfirmDialog from "./ConfirmDialog";
import { permanentlyDecryptMedia } from "../media/permanentDecryption";
import { onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { subscribeMessageMediaReady } from "../storage/mediaReady";
import type { ConversationTransportStatus } from "../net/transportManager";
import { getOutbox } from "../storage/outboxStore";
import { getReadCursors, getReceiptState } from "../storage/receiptStore";
import { getPrivacyPrefs, PRIVACY_PREFS_CHANGED_EVENT } from "../security/preferences";
import Avatar from "./Avatar";
import MessageGroupBubble, { type ChatMessageLike } from "./MessageGroupBubble";
import { groupMessages, type MessageGroup } from "../ui/groupMessages";
import { isSystemMessage, STARTED_CHAT_SYSTEM_TEXT } from "../ui/systemMessages";
import { isMessageVisible } from "../ui/messageVisibility";
import {
  MESSAGE_DELIVERY_LABELS,
  resolveMessageDeliveryStatus,
  type MessageDeliveryStatus,
} from "../ui/messageDeliveryStatus";

const EMPTY_ARRAY: Message[] = [];

const MAX_ATTACH_TOTAL_BYTES = 500 * 1024 * 1024;

const MAX_ATTACH_IMAGE_COUNT = 30;

const t = (ko: string, en: string) => useAppStore.getState().ui.language === "ko" ? ko : en;

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
    window.alert(t("단일 첨부는 500MB를 초과할 수 없습니다.", "Each attachment must be 500MB or less."));

    return false;
  }

  const { totalBytes, imageCount, totalCount } = computeAttachmentTotals(files);

  if (totalCount > MAX_ATTACH_TOTAL_COUNT) {
    window.alert(t(`첨부는 한 번에 최대 ${MAX_ATTACH_TOTAL_COUNT}개까지 가능합니다.`, `You can attach up to ${MAX_ATTACH_TOTAL_COUNT} files at once.`));

    return false;
  }

  if (imageCount > MAX_ATTACH_IMAGE_COUNT) {
    window.alert(t(`사진은 한 번에 최대 ${MAX_ATTACH_IMAGE_COUNT}장까지 가능합니다.`, `You can attach up to ${MAX_ATTACH_IMAGE_COUNT} photos at once.`));

    return false;
  }

  if (totalBytes > MAX_ATTACH_TOTAL_BYTES) {
    window.alert(t("첨부 총 용량은 500MB를 초과할 수 없습니다.", "Total attachments must be 500MB or less."));

    return false;
  }

  return true;
};

const formatTime = (ts: number) =>
  new Intl.DateTimeFormat(useAppStore.getState().ui.language === "en" ? "en-US" : "ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

const formatDate = (ts: number) =>
  new Intl.DateTimeFormat(useAppStore.getState().ui.language === "en" ? "en-US" : "ko-KR", {
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
  onSendBatch: (payload: { text: string; files: File[] }) => void | Promise<void>;
  onSendReadReceipt?: (payload: { convId: string; msgId: string; msgTs: number }) => void;
  onAcceptRequest?: () => void;
  onDeclineRequest?: () => void;
  onRequestDeletedContact?: () => void;
  onBlockDeletedContact?: () => void;
  onCancelOutgoingRequest?: () => void;
  friendActionBusy?: boolean;
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
  onRequestDeletedContact,
  onBlockDeletedContact,
  onCancelOutgoingRequest,
  friendActionBusy = false,
  onBack,
  onToggleRight,
  rightPanelOpen,
  onDeleteMessages,
  onToast,
}: ChatViewProps) {
  const messages = useAppStore((state) =>
    conversation ? state.messagesByConv[conversation.id] || EMPTY_ARRAY : EMPTY_ARRAY
  );

  const language = useAppStore((state) => state.ui.language);
  const t = useCallback((ko: string, en: string) => language === "ko" ? ko : en, [language]);
  const [atBottom, setAtBottom] = useState(true);
  const [decryptMedia, setDecryptMedia] = useState<ChatMessageLike | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(false);
  const [sendStates, setSendStates] = useState<Record<string, MessageDeliveryStatus>>({});
  const [readCursors, setReadCursors] = useState<Record<string, number>>({});
  const [copiedFriendCode, setCopiedFriendCode] = useState<string | null>(null);
  const [safetyTipsOpen, setSafetyTipsOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { firstMessageMeasurement.renderedIn(timelineRef.current); }, [messages]);
  const copyTimerRef = useRef<number | null>(null);
  const latestIncomingRef = useRef<HTMLDivElement | null>(null);

  const [messageMenu, setMessageMenu] = useState<{
    group: MessageGroup<ChatMessageLike>;
    mediaItem?: ChatMessageLike;
    x: number;
    y: number;
  } | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const [messageInfo, setMessageInfo] = useState<ChatMessageLike | null>(null);
  useEffect(() => { setMessageInfo(null); }, [conversation?.id, currentUserId]);

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
    (group: MessageGroup<ChatMessageLike>, event: ReactMouseEvent | ReactKeyboardEvent, mediaItem?: ChatMessageLike) => {
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 180;
      const menuHeight = 160;
      const padding = 8;
      const rect = event.currentTarget.getBoundingClientRect();
      const pointerEvent = "clientX" in event && event.clientX > 0;
      const requestedX = pointerEvent ? event.clientX : rect.left + rect.width / 2;
      const requestedY = pointerEvent ? event.clientY : rect.bottom;
      const x = Math.max(padding, Math.min(requestedX, window.innerWidth - menuWidth - padding));
      const y = Math.max(padding, Math.min(requestedY, window.innerHeight - menuHeight - padding));
      setMessageMenu({ group, mediaItem, x, y });
    },
    []
  );

  const downloadMedia = useCallback(
    async (item: ChatMessageLike) => {
      if (!item.media) return false;

      try {
        const blob = await loadMessageMedia(item.media);

        if (!blob) throw new Error("Media is unavailable");
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = (item.media.name || "image").replace(/[^a-zA-Z0-9.\-_가-힣]/g, "_");
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

        return true;
      } catch (error) {
        console.error("Failed to download message media", error);

        return false;
      }
    },
    []
  );

  const handleDownloadMedia = useCallback(async (item: ChatMessageLike) => {
    onToast?.(await downloadMedia(item) ? t("다운로드를 시작했습니다.", "Download started.") : t("다운로드에 실패했습니다.", "Download failed. Please try again."));
  }, [downloadMedia, onToast, t]);

  const handleDownloadMediaGroup = useCallback(async (group: MessageGroup<ChatMessageLike>) => {
    const images = group.items.filter((item) => item.media?.mime.startsWith("image/"));
    let downloaded = 0;

    for (const item of images) {
      if (await downloadMedia(item)) downloaded += 1;
    }

    onToast?.(
      downloaded === images.length
        ? `사진 ${downloaded}장을 다운로드했습니다.`
        : `사진 ${downloaded}/${images.length}장을 다운로드했습니다.`
    );
  }, [downloadMedia, onToast]);

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
        onToast?.(t("복사할 내용이 없습니다.", "Nothing to copy."));

        return;
      }

      try {
        let copied = false;

        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(payload);
            copied = true;
          }
        } catch {
          copied = false;
        }

        if (!copied) {
          const textarea = document.createElement("textarea");
          textarea.value = payload;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          copied = document.execCommand("copy");
          textarea.remove();
        }

        if (!copied) throw new Error("Clipboard copy was rejected");
        onToast?.(t("복사했습니다.", "Copied."));
      } catch (error) {
        console.error("Failed to copy message", error);
        onToast?.(t("복사에 실패했습니다.", "Could not copy."));
      }
    },
    [onToast, t]
  );

  useEffect(() => {
    if (!messageMenu) return;

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });

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
      window.cancelAnimationFrame(focusFrame);
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
  const reconnectRequired = !isGroup && peerProfile?.friendStatus === "deleted";
  const interactionLocked = requestIncoming || reconnectRequired;
  const pendingTextOnly = interactionLocked || requestOutgoing;
  const pendingFriendCode = peerProfile?.profileVcard?.friendCode;
  const codeCopied = Boolean(pendingFriendCode && copiedFriendCode === pendingFriendCode);

  const pendingSenderName = peerProfile
    ? nameMap[peerProfile.id] || peerProfile.displayName || t("알 수 없음", "Unknown")
    : t("알 수 없음", "Unknown");

  const [viewerGroup, setViewerGroup] = useState<ChatMessageLike[] | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerUrls, setViewerUrls] = useState<Record<string, string>>({});
  const [mediaReadyVersion, setMediaReadyVersion] = useState(0);
  const viewerRunRef = useRef(0);
  const viewerUrlsRef = useRef<Record<string, string>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => subscribeMessageMediaReady(() => setMediaReadyVersion((value) => value + 1)),
    []
  );

  const groupedBatches = useMemo(() => {
    const items: ChatMessageLike[] = messages.map((message) => ({
      ...message,
      text: isSystemMessage(message, currentUserId) && message.text === STARTED_CHAT_SYSTEM_TEXT
        ? t("채팅을 시작했어요.", "Chat started.") : message.text,
      senderId: isSystemMessage(message, currentUserId) ? "system" : message.senderId,
      createdAt: message.ts,
      kind: message.media ? "media" : "text",
    }));

    return groupMessages(items);
  }, [currentUserId, messages, t]);

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
  }, [currentUserId, groupedBatches, language]);

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

  const clearViewerPreviews = useCallback(() => {
    viewerRunRef.current += 1;
    setViewerUrls((prev) => {
      Object.values(prev).forEach((url) => URL.revokeObjectURL(url));

      return {};
    });
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

  useEffect(() => {
    const stop = onAccountOwnerChange(() => { closeViewer(); setDecryptMedia(null); });

    return () => { stop(); };
  }, [closeViewer]);

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
    const message = viewerGroup?.[viewerIndex], media = message?.media;

    if (!message || !media || !isPreviewableMedia(media)) return;
    const runId = ++viewerRunRef.current;
    let url: string | undefined;
    setViewerUrls({});

    const load = async () => {
      const blob = await loadMessageMedia(media);

      if (runId !== viewerRunRef.current || !blob) return;
      url = URL.createObjectURL(blob);
      setViewerUrls({ [message.id]: url });
    };

    void load().catch(() => {});

    return () => {
      ++viewerRunRef.current;

      if (url) URL.revokeObjectURL(url);
    };
  }, [mediaReadyVersion, viewerGroup, viewerIndex]);

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
      onToast?.(t("복사에 실패했습니다.", "Could not copy."));
    }
  }, [onToast, pendingFriendCode, t]);

  useEffect(() => {
    return () => {
      viewerRunRef.current += 1;
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
          outboxStatus: receiptState.outboxStatus ?? outbox?.status,
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

    if (interactionLocked) return;

    if (!latestIncoming) return;

    if (!isWindowActive) return;

    let cancelled = false;
    let checking = false;
    let completed = false;

    const sendReceipt = async () => {
      const group = latestIncomingRef.current;

      const target = group && ([...group.querySelectorAll<HTMLElement>("[data-msg-id]")]
        .find((element) => element.dataset.msgId === latestIncoming.id) ?? group);

      if (cancelled || checking || completed || !target || !isMessageVisible(target, timelineRef.current)) return;
      checking = true;

      try {
        const state = await getReceiptState(latestIncoming.id);
        const ownCursor = readCursors[currentUserId] ?? 0;

        if (state.read || ownCursor >= latestIncoming.ts) {
          completed = true;

          return;
        }

        if (cancelled || !isMessageVisible(target, timelineRef.current)) return;
        await onSendReadReceipt({
          convId: conversation.id,
          msgId: latestIncoming.id,
          msgTs: latestIncoming.ts,
        });
        completed = true;
      } finally {
        checking = false;
      }
    };

    // Recheck after scrolling or closing an overlay without relying on stale atBottom state.
    const check = () => { void sendReceipt().catch(() => {}); };

    check();
    const timer = window.setInterval(check, 500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    conversation,
    currentUserId,
    isWindowActive,
    latestIncoming,
    onSendReadReceipt,
    readCursors,
    readReceiptsEnabled,
    interactionLocked,
    atBottom,
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

  const transportLabel = (() => {
    if (!transportStatus?.kind) return null;
    const route = transportStatus.kind === "direct" ? "Direct" : "Onion";

    if (language === "en") {
      if (transportStatus.state === "connected") return `${route} connected`;

      if (transportStatus.state === "connecting") return `${route} connecting`;

      if (transportStatus.state === "failed") return `${route} recovering`;

      return `${route} waiting`;
    }

    if (transportStatus.state === "connected") return `${route} 연결됨`;

    if (transportStatus.state === "connecting") return `${route} 연결 중`;

    if (transportStatus.state === "failed") return `${route} 경로 복구 중`;

    return `${route} 대기 중`;
  })();

  const renderSendState = (state?: MessageDeliveryStatus) => {
    if (!state) return null;
    const label = MESSAGE_DELIVERY_LABELS[state];

    const icon =
      state === "failed" ? (
        <AlertTriangle size={13} aria-hidden="true" />
      ) : state === "queued" ? (
        <Clock size={13} aria-hidden="true" />
      ) : state === "sent" ? (
        <Check size={13} aria-hidden="true" />
      ) : (
        <CheckCheck size={13} aria-hidden="true" />
      );

    return (
      <span
        className="inline-flex items-center gap-1 text-inherit"
        role="img"
        aria-label={language === "en" ? label.en : label.ko}
        title={language === "en" ? label.en : label.ko}
        data-message-delivery-status={state}
      >
        {icon}
        {state === "queued" || state === "failed" ? <span className="text-[10px]">{language === "en" ? label.en : label.ko}</span> : null}
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

        if (!conversation || interactionLocked || requestOutgoing) return;
        const files = Array.from(event.dataTransfer?.files ?? []);

        if (!files.length) return;
        window.dispatchEvent(new CustomEvent("nkc:attach-files", { detail: { files } }));
      }}
    >
      <ConfirmDialog open={Boolean(decryptMedia)} title={t("파일 암호화 해제", "Decrypt file permanently")}
        message={t("이 파일은 Vault 보호를 벗어나 외부 프로그램에서 열 수 있게 됩니다. 다시 암호화할 수 없습니다. 계속하시겠습니까?",
          "This file will leave Vault protection and become accessible to other programs. It cannot be re-encrypted. Continue?")}
        dialogTestId="media-decryption-warning" confirmTestId="media-decryption-confirm"
        onClose={() => setDecryptMedia(null)} onConfirm={() => {
          const media = decryptMedia?.media;

          if (!media || decrypting) return;
          setDecrypting(true);
          void permanentlyDecryptMedia(media).then(completed => {
            if (completed) onToast?.(t("파일 암호화가 해제되었습니다.", "File permanently decrypted."));
          }).catch(() => onToast?.(t("암호화 해제를 완료하지 못했습니다. 원본은 보존됩니다.",
            "Decryption could not finish. The original is preserved."))).finally(() => setDecrypting(false));
        }} />
      {conversation ? (
      <header
        data-testid="chat-header"
        className="flex min-h-[50px] items-center justify-between border-b border-nkc-border bg-nkc-surface px-1 py-1"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-nkc-muted transition-colors hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
            aria-label={t("대화 목록으로 돌아가기", "Back to conversations")}
            title={t("대화 목록으로 돌아가기", "Back to conversations")}
          >
            <ArrowLeft size={16} />
          </button>
          {conversation ? (
            <Avatar
              name={conversationDisplayName || conversation.name}
              colorKey={isGroup ? conversation.id : peerProfile?.id ?? conversation.id}
              avatarRef={peerProfile?.avatarRef}
              size={42}
            />
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[15px] font-semibold text-nkc-text line-clamp-1">
                {conversation
                  ? conversationDisplayName || conversation.name
                  : t("대화를 선택하세요", "Select a conversation")}
              </div>
              {conversation && transportLabel ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                    transportStatus?.kind === "direct"
                      ? "border-nkc-dangerBorder text-nkc-danger bg-nkc-dangerBg"
                      : transportStatus?.state === "connected"
                        ? "border-nkc-successBorder bg-nkc-successBg text-nkc-success"
                        : transportStatus?.state === "failed"
                          ? "border-nkc-warningBorder bg-nkc-warningBg text-nkc-warning"
                          : "border-nkc-border bg-nkc-hover text-nkc-muted"
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  {transportStatus?.kind === "direct" ? <AlertTriangle size={12} /> : null}
                  {transportLabel}
                </span>
              ) : null}
              {conversation && requestOutgoing ? (
                <span className="inline-flex items-center rounded-full border border-nkc-border px-2 py-1 text-[11px] text-nkc-muted">
                  {t("초대됨", "Invited")}</span>
              ) : null}
            </div>
            {isGroup || peerProfile?.status?.trim() ? (
              <div className="text-xs text-nkc-muted line-clamp-1">
                {isGroup
                  ? t(`멤버 ${conversation.participants.length}명`, `${conversation.participants.length} ${conversation.participants.length === 1 ? "member" : "members"}`)
                  : peerProfile?.status?.trim()}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSearch}
            className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            disabled={!conversation}
            aria-label={t("채팅 검색", "Search chat")}
          >
            <Search size={14} />
          </button>
          <button
            onClick={onToggleRight}
            className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
            disabled={!conversation}
            aria-label={rightPanelOpen ? t("정보 닫기", "Close info") : t("대화 정보", "Conversation info")}
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
                placeholder={t("채팅 기록 검색", "Search chat history")}
                className="w-full bg-transparent text-xs text-nkc-text placeholder:text-nkc-muted focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              {searchQuery.trim() && searchMatches.length === 0 ? (
                <span className="rounded-full border border-nkc-border px-2 py-0.5 text-[10px] text-nkc-muted">
                  {t("없음", "None")}</span>
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
                {t("이전", "Previous")}</button>
              <button
                type="button"
                onClick={() => goToSearchResult(1)}
                disabled={!searchMatches.length}
                className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover disabled:opacity-40"
              >
                {t("다음", "Next")}</button>
              <button
                type="button"
                onClick={closeSearch}
                className="rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover"
              >
                {t("닫기", "Close")}</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={timelineRef}
          onScroll={handleScroll}
          data-testid="chat-timeline"
          className="scrollbar-hidden h-full overflow-y-auto bg-nkc-bg"
        >
          {conversation ? (
          <div className="ml-auto mr-0 flex w-full max-w-[min(100%,1800px)] flex-col gap-4 px-8 py-6">
            {requestIncoming || reconnectRequired ? (
              <div className="-mx-8 -mt-6 border-b border-nkc-border px-6 py-6 text-center" data-testid="message-request-profile">
                <Avatar
                  name={pendingSenderName}
                  colorKey={peerProfile?.id ?? conversation.id}
                  avatarRef={peerProfile?.avatarRef}
                  size={72}
                  className="mx-auto"
                />
                <div className="mt-3 text-lg font-semibold text-nkc-text">{pendingSenderName}</div>
                <div className="mt-1 text-xs text-nkc-muted">
                  {reconnectRequired ? t("삭제한 연락처에서 온 메시지", "Message from a deleted contact") : t("새 연락처의 메시지 요청", "Message request from a new contact")}
                </div>
                <button
                  type="button"
                  onClick={() => setSafetyTipsOpen((open) => !open)}
                  className="mt-3 rounded-full bg-nkc-hover px-4 py-2 text-xs font-semibold text-nkc-text hover:bg-nkc-selected"
                  aria-expanded={safetyTipsOpen}
                >
                  {t("안전 팁", "Safety tips")}</button>
                {safetyTipsOpen ? (
                  <div className="mx-auto mt-4 max-w-lg rounded-xl border border-nkc-border bg-nkc-panelMuted p-4 text-left text-xs leading-5 text-nkc-muted" data-testid="message-request-safety-tips">
                    <ul className="list-disc space-y-1 pl-4">
                      <li>{t("표시 이름과 프로필 사진만으로 상대의 신원을 확인할 수 없습니다.", "Display names and photos alone cannot verify someone’s identity.")}</li>
                      <li>{t("아는 사람이 맞는지 다른 연락 수단으로 먼저 확인하세요.", "Confirm who they are through another means of contact first.")}</li>
                      <li>{t("시작 키, PIN 또는 개인 키는 누구에게도 공유하지 마세요.", "Never share your start key, PIN or private keys.")}</li>
                    </ul>
                    {pendingFriendCode ? (
                      <div className="mt-3 flex min-w-0 items-center gap-2 border-t border-nkc-border pt-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-nkc-text">{pendingFriendCode}</span>
                        <button
                          type="button"
                          onClick={handleCopyFriendCode}
                          className="shrink-0 rounded-lg px-2 py-1 font-semibold text-nkc-accent hover:bg-nkc-hover"
                        >
                          {codeCopied ? t("복사됨", "Copied") : t("코드 복사", "Copy code")}
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
                  <div className="text-nkc-text">{t("친구 요청을 보냈습니다.", "Friend request sent.")}</div>
                  <div className="text-xs text-nkc-muted">
                    {t("상대가 수락하면 바로 대화를 시작할 수 있습니다.", "You can start chatting when your friend accepts.")}</div>
                </div>
                {onCancelOutgoingRequest ? (
                  <button
                    type="button"
                    onClick={onCancelOutgoingRequest}
                    className="rounded-lg px-3 py-1.5 text-xs text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text"
                  >
                    {t("친구추가요청 취소", "Cancel friend request")}</button>
                ) : null}
              </div>
            ) : null}
            {friendActionBusy && !requestIncoming && !requestOutgoing && !reconnectRequired ? (
              <div
                className="rounded-lg bg-nkc-surface px-4 py-3 text-center text-xs text-nkc-muted"
                role="status"
                aria-live="polite"
              >
                {t("친구 상태를 저장하고 상대 기기에 전달하는 중입니다.", "Saving friend status and delivering it to the other device.")}</div>
            ) : null}
            {renderGroups.map(({ group, dateLabel, showSender }) => {
              const senderProfile = profilesById[group.senderId];

              const senderName =
                group.senderId === currentUserId
                  ? t("나", "Me")
                  : nameMap[group.senderId] || senderProfile?.displayName || t("알 수 없음", "Unknown");

              const isSystem = group.senderId === "system";

              const lastMessage = group.items.reduce((latest, item) =>
                item.ts > latest.ts ? item : latest
              );

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
                          onRequestMenu={(event, item) => openMessageMenu(group, event, item)}
                          highlightQuery={searchOpen ? searchQuery : ""}
                          footer={
                            <>
                              <span>{formatTime(lastMessage.ts)}</span>
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
                <div className="text-sm font-semibold text-nkc-warning">
                  {t("신중하게 메시지 요청을 검토하세요", "Review this message request carefully")}</div>
                <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-nkc-muted">
                  {pendingSenderName}{t("님이 처음 메시지를 보냈습니다. 수락하기 전까지 상대방은 읽음 여부를 확인할 수 없으며, 메시지 전송도 제한됩니다.", " sent you a first message. Until you accept, read status is hidden and messaging is limited.")}</p>
                <div className="mt-4 flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={onDeclineRequest}
                    disabled={friendActionBusy}
                    className="min-w-28 rounded-full bg-nkc-hover px-5 py-2 text-sm font-semibold text-nkc-danger hover:bg-nkc-dangerBg"
                  >
                    {t("차단", "Block")}</button>
                  <button
                    type="button"
                    onClick={onAcceptRequest}
                    disabled={friendActionBusy}
                    className="min-w-28 rounded-full bg-nkc-accent px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
                  >
                    {friendActionBusy ? t("처리 중...", "Processing...") : t("수락", "Accept")}
                  </button>
                </div>
              </div>
            ) : null}
            {reconnectRequired ? (
              <div
                className="mx-auto mt-2 w-full max-w-2xl border-t border-nkc-border pt-5 text-center"
                data-testid="deleted-contact-actions"
              >
                <div className="text-sm font-semibold text-nkc-warning">{t("다시 연결이 필요합니다", "Reconnect with this contact")}</div>
                <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-nkc-muted">
                  {t("삭제한 연락처가 메시지를 보냈습니다. 상대를 차단하거나 새 친구 요청을 보낼 수 있습니다.", "A deleted contact sent a message. You can block them or send a new friend request.")}</p>
                <div className="mt-4 flex justify-center gap-3">
                  <button
                    type="button"
                    onClick={onBlockDeletedContact}
                    disabled={friendActionBusy}
                    className="min-w-28 rounded-full bg-nkc-hover px-5 py-2 text-sm font-semibold text-nkc-danger hover:bg-nkc-dangerBg"
                  >
                    {t("차단", "Block")}</button>
                  <button
                    type="button"
                    onClick={onRequestDeletedContact}
                    disabled={friendActionBusy}
                    className="min-w-32 rounded-full bg-nkc-accent px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
                  >
                    {friendActionBusy ? t("처리 중...", "Processing...") : t("친구 요청 보내기", "Send friend request")}
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
            <div className="text-lg font-semibold text-nkc-text">{t("NKC에 오신 것을 환영합니다", "Welcome to NKC")}</div>
            <div className="max-w-sm text-sm leading-6">
              {t("친구를 추가하거나 왼쪽에서 대화를 선택해 시작하세요.", "Add a friend or select a conversation on the left to get started.")}</div>
            <div className="absolute bottom-6 text-xs text-nkc-muted">
              {t("NKC의 대화는 종단간 암호화됩니다.", "NKC conversations are end-to-end encrypted.")}</div>
          </div>
          )}
        </div>

        {!atBottom && conversation ? (
          <button
            type="button"
            onClick={() => scrollToBottom(timelineRef.current)}
            data-testid="scroll-to-bottom"
            className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-nkc-accent px-4 py-2 text-xs font-medium text-white shadow-lg hover:brightness-110 focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
          >
            <ArrowDown size={12} />
            {t("맨 아래로", "Scroll to bottom")}</button>
        ) : null}
      </div>

      {messageMenu ? (
        <div className="fixed inset-0 z-50">
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("메시지 메뉴", "Message menu")}
            className="pointer-events-auto fixed min-w-[140px] rounded-lg border border-nkc-border bg-nkc-surface p-1 text-xs animate-signal-fade-scale"
            style={{ left: messageMenu.x, top: messageMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const current = items.indexOf(document.activeElement as HTMLButtonElement);

              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                items[(current + direction + items.length) % items.length]?.focus();
              }

              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                items[event.key === "Home" ? 0 : items.length - 1]?.focus();
              }
            }}
          >
            {(messageMenu.mediaItem?.media || messageMenu.group.items.some(item => item.media)) ? (
              <button type="button" role="menuitem" data-testid="message-media-decrypt-permanently"
                disabled={decrypting}
                className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover disabled:opacity-50"
                onClick={() => {
                  setDecryptMedia(messageMenu.mediaItem?.media ? messageMenu.mediaItem : messageMenu.group.items.find(item => item.media) ?? null);
                  setMessageMenu(null);
                }}>
                {t("암호화 해제", "Decrypt permanently")}
              </button>
            ) : null}
            {messageMenu.mediaItem?.media?.mime.startsWith("image/") &&
            messageMenu.group.items.filter((item) => item.media?.mime.startsWith("image/")).length === 1 ? (
              <button
                type="button"
                role="menuitem"
                data-testid="message-media-download"
                className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover"
                onClick={() => {
                  void handleDownloadMedia(messageMenu.mediaItem!);
                  setMessageMenu(null);
                }}
              >
                {t("다운로드", "Download")}</button>
            ) : null}
            {messageMenu.mediaItem?.media?.mime.startsWith("image/") &&
            messageMenu.group.items.filter((item) => item.media?.mime.startsWith("image/")).length > 1 ? (
              <button
                type="button"
                role="menuitem"
                data-testid="message-media-download-all"
                className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover"
                onClick={() => {
                  void handleDownloadMediaGroup(messageMenu.group);
                  setMessageMenu(null);
                }}
              >
                {t("모두 다운로드", "Download all")}</button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover"
              onClick={() => {
                setMessageInfo(messageMenu.mediaItem ?? messageMenu.group.items.at(-1) ?? null);
                setMessageMenu(null);
              }}
            >
              {language === "en" ? "Message info" : "메시지 정보"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-text hover:bg-nkc-hover"
              onClick={() => {
                void handleCopyGroup(messageMenu.group);
                setMessageMenu(null);
              }}
            >
              {t("복사", "Copy")}</button>
            {onDeleteMessages ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-nkc-danger hover:bg-nkc-dangerBg"
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
                {t("삭제", "Delete")}</button>
            ) : null}
          </div>
        </div>
      ) : null}

      <Dialog.Root open={Boolean(messageInfo)} onOpenChange={open => { if (!open) setMessageInfo(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="nkc-modal-overlay fixed inset-0 bg-black/60" />
          <Dialog.Content className="nkc-modal-content fixed left-1/2 top-1/2 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-nkc border border-nkc-border bg-nkc-panel p-6 text-nkc-text shadow-soft">
            <Dialog.Title>{language === "en" ? "Message info" : "메시지 정보"}</Dialog.Title>
            <Dialog.Description className="my-3 text-sm text-nkc-muted">
              {messageInfo ? new Date(messageInfo.ts).toLocaleString(language === "en" ? "en-US" : "ko-KR") : ""}
            </Dialog.Description>
            {messageInfo?.senderId === currentUserId ? (
              <ul className="space-y-2 text-sm">
                {(conversation?.participants ?? []).filter(id => id !== currentUserId).map(id => (
                  <li key={id} className="flex justify-between gap-4">
                    <span>{nameMap[id] || profilesById[id]?.displayName || (language === "en" ? "Unknown" : "알 수 없음")}</span>
                    <span>{readReceiptsEnabled && (readCursors[id] ?? -1) >= messageInfo.ts
                      ? (language === "en" ? "Read" : "읽음")
                      : (language === "en" ? "Read not confirmed" : "읽음 확인 없음")}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Dialog.Close className="mt-4 rounded-nkc border border-nkc-border px-3 py-2 text-sm hover:bg-nkc-hover">
              {language === "en" ? "Close" : "닫기"}
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {viewerGroup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="relative w-full max-w-3xl rounded-xl bg-nkc-surface p-4">
            <button
              type="button"
              onClick={closeViewer}
              className="absolute right-4 top-4 rounded-md px-2 py-1 text-[11px] text-nkc-text hover:bg-nkc-hover"
            >
              {t("닫기", "Close")}</button>
            <div className="flex items-center justify-between text-xs text-nkc-muted pr-10">
              <span className="line-clamp-1">
                {viewerGroup[viewerIndex]?.media?.name || "미디어"}
              </span>
            </div>
            <div className="mb-2 flex justify-end gap-1">
              <button type="button" aria-label={t("다운로드", "Download")} className="rounded-md p-2 text-nkc-text hover:bg-nkc-hover" onClick={() => void handleDownloadMedia(viewerGroup[viewerIndex])}>
                <Download size={15} />
              </button>
              <button type="button" aria-label={t("복사", "Copy")} className="rounded-md p-2 text-nkc-text hover:bg-nkc-hover" onClick={() => void handleCopyGroup({ items: [viewerGroup[viewerIndex]], key: viewerGroup[viewerIndex].id, senderId: viewerGroup[viewerIndex].senderId, createdAt: viewerGroup[viewerIndex].createdAt })}>
                <Copy size={15} />
              </button>
            </div>
            <div className="relative mt-3 flex items-center justify-center">
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
                    {t("미리보기를 불러오는 중...", "Loading preview...")}</div>
                );
              })()}
              {viewerGroup.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setViewerIndex((prev) => Math.max(0, prev - 1))}
                    disabled={viewerIndex === 0}
                    aria-label={t("이전 사진", "Previous photo")}
                    className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:invisible"
                  >
                    <ChevronLeft size={24} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewerIndex((prev) => Math.min(viewerGroup.length - 1, prev + 1))}
                    disabled={viewerIndex >= viewerGroup.length - 1}
                    aria-label={t("다음 사진", "Next photo")}
                    className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:invisible"
                  >
                    <ChevronRight size={24} />
                  </button>
                </>
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-center">
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

      {conversation && !interactionLocked ? (
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
  onSendBatch: (payload: { text: string; files: File[] }) => void | Promise<void>;
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
  const [sending, setSending] = useState(false);
  const sendInFlightRef = useRef(false);
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

    window.addEventListener("nkc:attach-files", handler);

    return () => {
      window.removeEventListener("nkc:attach-files", handler);
    };
  }, [addFilesToQueue, conversation, disabled, textOnly]);

  const handleSend = async () => {
    if (!conversation || disabled || sendInFlightRef.current) return;
    const trimmed = text.trim();
    const hasText = Boolean(trimmed);
    const hasAttachments = attachments.length > 0;

    if (textOnly && hasAttachments) return;

    if (!hasText && !hasAttachments) return;

    const files = attachments;
    sendInFlightRef.current = true;
    setSending(true);

    if (hasText) setText("");

    if (hasAttachments) setAttachments([]);

    try {
      await onSendBatch({ text: trimmed, files });
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
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
        void handleSend();
      }}
      className={`border-t border-nkc-border bg-nkc-bg px-4 py-3 ${
        conversation && !disabled ? "" : "opacity-60"
      }`}
    >
      <div className="nkc-input-group rounded-[18px] bg-nkc-hover p-3 transition-[background-color,box-shadow] duration-150 ease-out">
        {textOnly ? (
          <div className="mb-2 text-xs text-nkc-muted">
            {t("요청 대기중: 텍스트만 전송할 수 있습니다.", "Request pending: only text can be sent.")}</div>
        ) : null}
        {attachments.length ? (
          <div className="mb-2 flex items-center justify-between text-xs text-nkc-muted">
            <span>
              {t("첨부", "Attach")}{attachments.length}{t("개 / 사진", "files / photos")}{attachmentImageCount}{t("장", "images")}</span>
            <button
              type="button"
              onClick={() => setAttachments([])}
              className="text-nkc-danger hover:text-nkc-danger"
            >
              {t("첨부 취소", "Remove attachment")}</button>
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
              void handleSend();
            }
          }}
          className="h-auto min-h-5 max-h-[60px] w-full resize-none overflow-y-hidden bg-transparent text-sm leading-5 text-nkc-text transition-[height] duration-100 ease-out placeholder:text-nkc-muted focus:outline-none"
          placeholder={t("메시지를 입력하세요", "Type a message")}
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
            disabled={
              !conversation ||
              disabled ||
              sending ||
              (!text.trim() && attachments.length === 0)
            }
            className="rounded-full bg-nkc-accent px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-30 hover:brightness-110"
          >
            {sending ? t("전송 중…", "Sending…") : t("전송", "Send")}
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
