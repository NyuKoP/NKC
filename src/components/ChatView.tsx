import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, PanelRight } from "lucide-react";
import type { Conversation, Message } from "../db/repo";

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
  messages: Message[];
  currentUserId: string | null;
  nameMap: Record<string, string>;
  isComposing: boolean;
  onComposingChange: (value: boolean) => void;
  onSend: (text: string) => void;
  onBack: () => void;
  onToggleRight: () => void;
  rightPanelOpen: boolean;
};

export default function ChatView({
  conversation,
  messages,
  currentUserId,
  nameMap,
  isComposing,
  onComposingChange,
  onSend,
  onBack,
  onToggleRight,
  rightPanelOpen,
}: ChatViewProps) {
  const [text, setText] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const grouped = useMemo(
    () => groupMessages(messages, currentUserId, nameMap),
    [messages, currentUserId, nameMap]
  );

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(
      textareaRef.current.scrollHeight,
      160
    )}px`;
  }, [text]);

  useEffect(() => {
    if (!conversation) {
      setText("");
      return;
    }
    if (atBottom) {
      requestAnimationFrame(() => scrollToBottom(timelineRef.current));
    }
  }, [messages.length, conversation?.id]);

  useEffect(() => {
    if (conversation) {
      requestAnimationFrame(() => scrollToBottom(timelineRef.current));
    }
  }, [conversation?.id]);

  const handleScroll = () => {
    if (!timelineRef.current) return;
    const el = timelineRef.current;
    const threshold = 48;
    const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    setAtBottom(isBottom);
  };

  const handleSend = () => {
    if (!conversation) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <section className="flex h-full flex-1 flex-col rounded-nkc border border-nkc-border bg-nkc-panel shadow-soft">
      <header className="flex items-center justify-between border-b border-nkc-border px-6 py-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-nkc-border text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <div className="text-base font-semibold text-nkc-text line-clamp-1">
              {conversation ? conversation.name : "대화를 선택하세요"}
            </div>
            <div className="text-xs text-nkc-muted line-clamp-1">
              {conversation ? "마지막 활동 2분 전" : "왼쪽에서 대화를 선택하세요."}
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
            {grouped.map((group) => (
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
                    <div className="mt-1 h-8 w-8 rounded-full bg-nkc-panelMuted" />
                  ) : null}
                  <div className="flex max-w-chat flex-col gap-2">
                    {group.senderId !== currentUserId ? (
                      <span className="text-xs text-nkc-muted">{group.senderName}</span>
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
                        {message.text}
                        <div className="mt-2 text-[11px] text-nkc-muted">
                          {formatTime(message.ts)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-nkc-muted">
            <div className="text-3xl">💬</div>
            <div className="text-base font-semibold">대화를 선택하세요</div>
            <div className="text-sm">왼쪽에서 대화를 고르면 메시지가 보입니다.</div>
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
          />
          <div className="mt-3 flex items-center justify-between text-xs text-nkc-muted">
            <span>{text.length} / 240</span>
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
    </section>
  );
}

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
          : nameMap[message.senderId] || "상대",
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
