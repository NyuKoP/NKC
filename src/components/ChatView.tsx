import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, ArrowLeft, ArrowUp, FileText, PanelRight, Paperclip } from "lucide-react";
import type { Conversation, MediaRef, Message, UserProfile } from "../db/repo";
import { loadMessageMedia } from "../db/repo";
import type { ConversationTransportStatus } from "../net/transportManager";
import Avatar from "./Avatar";

const GROUP_WINDOW_MS = 1000 * 60 * 2;

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
  transportStatus?: ConversationTransportStatus | null;
  messages: Message[];
  currentUserId: string | null;
  nameMap: Record<string, string>;
  profilesById: Record<string, UserProfile | undefined>;
  isComposing: boolean;
  onComposingChange: (value: boolean) => void;
  onSend: (text: string) => void;
  onSendMedia: (file: File) => void;
  onBack: () => void;
  onToggleRight: () => void;
  rightPanelOpen: boolean;
};

export default function ChatView({
  conversation,
  transportStatus,
  messages,
  currentUserId,
  nameMap,
  profilesById,
  isComposing,
  onComposingChange,
  onSend,
  onSendMedia,
  onBack,
  onToggleRight,
  rightPanelOpen,
}: ChatViewProps) {
  const [atBottom, setAtBottom] = useState(true);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const grouped = useMemo(
    () => groupMessages(messages, currentUserId, nameMap),
    [messages, currentUserId, nameMap]
  );

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

  return (
    <section
      className="flex h-full flex-1 flex-col rounded-nkc border border-nkc-border bg-nkc-panel shadow-soft"
      data-testid="chat-view"
    >
      <header className="flex items-center justify-between border-b border-nkc-border px-6 py-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold text-nkc-text line-clamp-1">
                {conversation ? conversation.name : "대화를 선택하세요"}
              </div>
              {conversation && transportLabel ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${
                    transportStatus?.kind === "direct"
                      ? "border-red-400/40 text-red-200"
                      : "border-nkc-border text-nkc-muted"
                  }`}
                >
                  {transportStatus?.kind === "direct" ? <AlertTriangle size={12} /> : null}
                  {transportLabel}
                </span>
              ) : null}
            </div>
            <div className="text-xs text-nkc-muted line-clamp-1">
              {conversation ? "마지막 활동 2분 전" : "왼쪽에서 대화를 선택하세요"}
            </div>
          </div>
        </div>
        <button
          onClick={onToggleRight}
          className="flex h-9 items-center gap-2 rounded-nkc border border-nkc-border px-3 text-xs text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text"
          disabled={!conversation}
        >
          <PanelRight size={14} />
          {rightPanelOpen ? "닫기" : "정보"}
        </button>
      </header>

      <div
        ref={timelineRef}
        onScroll={handleScroll}
        className="scrollbar-thin relative flex-1 overflow-y-auto bg-nkc-panelMuted"
      >
        {conversation ? (
          <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-8 py-6">
            {grouped.map((group) => {
              const senderProfile = profilesById[group.senderId];
              const senderName = senderProfile?.displayName || group.senderName;
              return (
                <div key={group.key} className="space-y-2">
                  {group.dateLabel ? (
                    <div className="flex justify-center">
                      <span className="rounded-full border border-nkc-border bg-nkc-panel px-3 py-1 text-xs font-medium text-nkc-muted">
                        {group.dateLabel}
                      </span>
                    </div>
                  ) : null}
                  <div
                    className={`flex gap-3 ${
                      group.senderId === currentUserId ? "justify-end" : "justify-start"
                    }`}
                  >
                    {group.senderId !== currentUserId ? (
                      <Avatar
                        name={senderName}
                        avatarRef={senderProfile?.avatarRef}
                        size={32}
                        className="mt-1"
                      />
                    ) : null}
                    <div className="flex max-w-chat flex-col gap-2">
                      {group.senderId !== currentUserId ? (
                        <span className="text-xs text-nkc-muted">{senderName}</span>
                      ) : null}
                      {group.messages.map((message) => (
                        <div
                          key={message.id}
                          className={`rounded-nkc border px-4 py-3 text-sm leading-relaxed ${
                            group.senderId === currentUserId
                              ? "border-nkc-accent/40 bg-nkc-panelMuted text-nkc-text"
                              : "border-nkc-border bg-nkc-panel text-nkc-text"
                          }`}
                        >
                          {message.media ? (
                            <MediaAttachment media={message.media} />
                          ) : (
                            message.text
                          )}
                          <div className="mt-2 text-[11px] text-nkc-muted">
                            {formatTime(message.ts)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-nkc-muted">
            <div className="text-3xl">💬</div>
            <div className="text-base font-semibold">대화를 선택하세요</div>
            <div className="text-sm">왼쪽에서 대화를 골라 메시지가 표시됩니다.</div>
          </div>
        )}

        {!atBottom && conversation ? (
          <button
            onClick={() => scrollToBottom(timelineRef.current)}
            className="absolute bottom-6 right-6 flex items-center gap-2 rounded-full border border-nkc-border bg-nkc-panel px-4 py-2 text-xs text-nkc-text shadow-soft"
          >
            <ArrowUp size={12} />
            맨 아래로
          </button>
        ) : null}
      </div>

      <MessageComposer
        key={conversation?.id ?? "none"}
        conversation={conversation}
        isComposing={isComposing}
        onComposingChange={onComposingChange}
        onSend={onSend}
        onSendMedia={onSendMedia}
      />
    </section>
  );
}

type MessageComposerProps = {
  conversation: Conversation | null;
  isComposing: boolean;
  onComposingChange: (value: boolean) => void;
  onSend: (text: string) => void;
  onSendMedia: (file: File) => void;
};

const MessageComposer = ({
  conversation,
  isComposing,
  onComposingChange,
  onSend,
  onSendMedia,
}: MessageComposerProps) => {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(
      textareaRef.current.scrollHeight,
      160
    )}px`;
  }, [text]);

  const handleSend = () => {
    if (!conversation) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  const handleMediaSelect = (event: ChangeEvent<HTMLInputElement>) => {
    if (!conversation) return;
    const file = event.target.files?.[0];
    if (!file) return;
    onSendMedia(file);
    event.target.value = "";
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isComposing) return;
        handleSend();
      }}
      className={`border-t border-nkc-border bg-nkc-panel px-6 py-5 ${
        conversation ? "" : "opacity-60"
      }`}
    >
      <div className="rounded-nkc border border-nkc-border bg-nkc-panelMuted p-3">
        <textarea
          ref={textareaRef}
          disabled={!conversation}
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
          className="h-auto w-full resize-none bg-transparent text-sm leading-relaxed text-nkc-text placeholder:text-nkc-muted focus:outline-none"
          placeholder="메시지를 입력하세요"
          rows={1}
          maxLength={240}
          data-testid="chat-message-input"
        />
        <div className="mt-3 flex items-center justify-between text-xs text-nkc-muted">
          <div className="flex items-center gap-3">
            <label
              className={`flex h-8 w-8 items-center justify-center rounded-full border border-nkc-border text-nkc-muted hover:bg-nkc-panel ${
                conversation ? "" : "pointer-events-none opacity-50"
              }`}
              data-testid="chat-attach-button"
            >
              <Paperclip size={14} />
              <input
                type="file"
                accept="image/*,video/*,audio/*"
                className="hidden"
                onChange={handleMediaSelect}
                data-testid="chat-attach-input"
              />
            </label>
            <span>{text.length} / 240</span>
          </div>
          <button
            type="submit"
            disabled={!conversation || !text.trim()}
            className="rounded-nkc bg-nkc-accent px-4 py-2 text-xs font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            전송
          </button>
        </div>
      </div>
    </form>
  );
};

type MediaAttachmentProps = {
  media: MediaRef;
};

const MediaAttachment = ({ media }: MediaAttachmentProps) => {
  const [blob, setBlob] = useState<Blob | null>(null);
  const isImage = media.mime.startsWith("image/");
  const previewUrl = useMemo(
    () => (isImage && blob ? URL.createObjectURL(blob) : null),
    [isImage, blob]
  );

  useEffect(() => {
    if (!isImage) return;
    let active = true;

    const load = async () => {
      try {
        const nextBlob = await loadMessageMedia(media);
        if (!nextBlob || !active) return;
        setBlob(nextBlob);
      } catch (error) {
        console.error("Failed to load media", error);
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [isImage, media]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (isImage) {
    return previewUrl ? (
      <img
        src={previewUrl}
        alt={media.name}
        className="max-h-48 w-full rounded-nkc border border-nkc-border object-cover"
        data-testid="media-message-bubble"
      />
    ) : (
      <div
        className="h-32 w-full rounded-nkc border border-nkc-border bg-nkc-panelMuted"
        data-testid="media-message-bubble"
      />
    );
  }

  return (
    <div
      className="flex items-center gap-2 rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2 text-xs"
      data-testid="media-message-bubble"
    >
      <FileText size={14} className="text-nkc-muted" />
      <div className="min-w-0">
        <div className="text-nkc-text line-clamp-1">{media.name}</div>
        <div className="text-[11px] text-nkc-muted">{formatBytes(media.size)}</div>
      </div>
    </div>
  );
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

type GroupedMessage = {
  key: string;
  senderId: string;
  senderName: string;
  dateLabel?: string;
  messages: Message[];
};

const groupMessages = (
  messages: Message[],
  currentUserId: string | null,
  nameMap: Record<string, string>
): GroupedMessage[] => {
  const groups: GroupedMessage[] = [];
  let lastDate = "";

  messages.forEach((message) => {
    const dateLabel = formatDate(message.ts);
    const lastGroup = groups[groups.length - 1];
    const canGroup =
      lastGroup &&
      lastGroup.senderId === message.senderId &&
      message.ts - lastGroup.messages[lastGroup.messages.length - 1].ts <=
        GROUP_WINDOW_MS;

    if (canGroup) {
      lastGroup.messages.push(message);
      return;
    }

    const withDate = dateLabel !== lastDate ? dateLabel : undefined;
    lastDate = dateLabel;
    groups.push({
      key: message.id,
      senderId: message.senderId,
      senderName:
        message.senderId === currentUserId
          ? "나"
          : nameMap[message.senderId] || "알 수 없음",
      dateLabel: withDate,
      messages: [message],
    });
  });

  return groups;
};

const scrollToBottom = (el: HTMLDivElement | null) => {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
};
