import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import SettingsModal from "../components/SettingsModal";
import Toast, { useToastQueue } from "../components/Toast";
import {
  BackIcon,
  MessageIcon,
  MoreIcon,
  PanelIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from "../components/icons/Icons";

type Contact = {
  id: string;
  displayName: string;
  status: "online" | "away" | "offline";
};

type Conversation = {
  id: string;
  title: string;
  lastMessage: string;
  lastTime: string;
  lastSeen: string;
  unreadCount: number;
};

type Message = {
  id: string;
  conversationId: string;
  author: string;
  body: string;
  sentAt: string;
  direction: "in" | "out";
};

const contacts: Contact[] = [
  { id: "contact-1", displayName: "Mika", status: "online" },
  { id: "contact-2", displayName: "Noah", status: "away" },
  { id: "contact-3", displayName: "Ari", status: "offline" },
  { id: "contact-4", displayName: "Jun", status: "online" },
];

const initialPinnedConversations: Conversation[] = [
  {
    id: "conv-1",
    title: "Priya",
    lastMessage: "We should ship the draft tonight.",
    lastTime: "09:42",
    lastSeen: "5m ago",
    unreadCount: 2,
  },
  {
    id: "conv-2",
    title: "Dev Group",
    lastMessage: "Build is green again.",
    lastTime: "08:17",
    lastSeen: "15m ago",
    unreadCount: 0,
  },
];

const initialConversations: Conversation[] = [
  {
    id: "conv-3",
    title: "Luca",
    lastMessage: "Ship notes look great.",
    lastTime: "Yesterday",
    lastSeen: "1h ago",
    unreadCount: 1,
  },
  {
    id: "conv-4",
    title: "Session Korea",
    lastMessage: "See you at 3pm.",
    lastTime: "Yesterday",
    lastSeen: "2h ago",
    unreadCount: 0,
  },
  {
    id: "conv-5",
    title: "Rita",
    lastMessage: "Coffee soon?",
    lastTime: "Mon",
    lastSeen: "3h ago",
    unreadCount: 3,
  },
];

const initialMessages: Record<string, Message[]> = {
  "conv-1": [
    {
      id: "msg-1",
      conversationId: "conv-1",
      author: "Priya",
      body: "We should ship the draft tonight.",
      sentAt: "09:12",
      direction: "in",
    },
    {
      id: "msg-2",
      conversationId: "conv-1",
      author: "Me",
      body: "Agree. I'll prep the handoff notes.",
      sentAt: "09:14",
      direction: "out",
    },
    {
      id: "msg-3",
      conversationId: "conv-1",
      author: "Priya",
      body: "Great. I will review after lunch.",
      sentAt: "09:17",
      direction: "in",
    },
  ],
  "conv-2": [
    {
      id: "msg-4",
      conversationId: "conv-2",
      author: "Evan",
      body: "Build is green again.",
      sentAt: "08:17",
      direction: "in",
    },
  ],
  "conv-3": [
    {
      id: "msg-5",
      conversationId: "conv-3",
      author: "Luca",
      body: "Ship notes look great.",
      sentAt: "22:04",
      direction: "in",
    },
    {
      id: "msg-6",
      conversationId: "conv-3",
      author: "Me",
      body: "Thanks! Will send the release build soon.",
      sentAt: "22:10",
      direction: "out",
    },
  ],
  "conv-4": [
    {
      id: "msg-7",
      conversationId: "conv-4",
      author: "Sora",
      body: "See you at 3pm.",
      sentAt: "17:22",
      direction: "in",
    },
  ],
  "conv-5": [
    {
      id: "msg-8",
      conversationId: "conv-5",
      author: "Rita",
      body: "Coffee soon?",
      sentAt: "Mon",
      direction: "in",
    },
    {
      id: "msg-9",
      conversationId: "conv-5",
      author: "Me",
      body: "Sure. Today 4?",
      sentAt: "Mon",
      direction: "out",
    },
  ],
};

const accountFingerprint =
  "05d1c9-2a94-4f6b-b3aa-7e2f-9c18-9f31-4b20";

const formatTime = (date: Date) =>
  date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const MAX_TEXTAREA_HEIGHT = 160;
const SCROLL_THRESHOLD_PX = 48;

const ChatScreen = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [pinnedConversations, setPinnedConversations] = useState<Conversation[]>(
    initialPinnedConversations
  );
  const [conversations, setConversations] = useState<Conversation[]>(
    initialConversations
  );
  const [messagesByConv, setMessagesByConv] =
    useState<Record<string, Message[]>>(initialMessages);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [pendingScroll, setPendingScroll] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { toasts, push, dismiss } = useToastQueue();

  const selectedConversation = useMemo(() => {
    return (
      pinnedConversations.find((conv) => conv.id === selectedConvId) ??
      conversations.find((conv) => conv.id === selectedConvId) ??
      null
    );
  }, [conversations, pinnedConversations, selectedConvId]);

  const selectedMessages = useMemo(() => {
    if (!selectedConvId) return [];
    return messagesByConv[selectedConvId] ?? [];
  }, [messagesByConv, selectedConvId]);

  const filteredPinned = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return pinnedConversations;
    return pinnedConversations.filter(
      (conv) =>
        conv.title.toLowerCase().includes(term) ||
        conv.lastMessage.toLowerCase().includes(term)
    );
  }, [pinnedConversations, searchTerm]);

  const filteredConversations = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter(
      (conv) =>
        conv.title.toLowerCase().includes(term) ||
        conv.lastMessage.toLowerCase().includes(term)
    );
  }, [conversations, searchTerm]);

  const scrollToBottom = useCallback(() => {
    const container = timelineRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const isNearBottom = useCallback(() => {
    const container = timelineRef.current;
    if (!container) return true;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      SCROLL_THRESHOLD_PX
    );
  }, []);

  const handleTimelineScroll = useCallback(() => {
    setIsAtBottom(isNearBottom());
  }, [isNearBottom]);

  const adjustTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(
      textarea.scrollHeight,
      MAX_TEXTAREA_HEIGHT
    )}px`;
  }, []);

  const updateConversationList = useCallback(
    (id: string, updates: Partial<Conversation>) => {
      const applyUpdates = (list: Conversation[]) => {
        const index = list.findIndex((conv) => conv.id === id);
        if (index === -1) return list;
        const updated = { ...list[index], ...updates };
        return [updated, ...list.filter((_, idx) => idx !== index)];
      };
      setPinnedConversations((prev) => applyUpdates(prev));
      setConversations((prev) => applyUpdates(prev));
    },
    []
  );

  const markConversationRead = useCallback(
    (id: string) => updateConversationList(id, { unreadCount: 0 }),
    [updateConversationList]
  );

  const handleSelectConversation = useCallback(
    (id: string) => {
      setSelectedConvId(id);
      setIsAtBottom(true);
      markConversationRead(id);
      requestAnimationFrame(scrollToBottom);
    },
    [markConversationRead, scrollToBottom]
  );

  const handleBack = useCallback(() => {
    setSelectedConvId(null);
    setIsRightPanelOpen(false);
    setIsAtBottom(true);
  }, []);

  const handleSend = useCallback(() => {
    if (!selectedConvId) return;
    const trimmed = composerValue.trim();
    if (!trimmed) return;

    const timeLabel = formatTime(new Date());
    const newMessage: Message = {
      id: `msg-${Date.now()}`,
      conversationId: selectedConvId,
      author: "Me",
      body: trimmed,
      sentAt: timeLabel,
      direction: "out",
    };
    const shouldAutoScroll = isNearBottom();

    setMessagesByConv((prev) => {
      const existing = prev[selectedConvId] ?? [];
      return { ...prev, [selectedConvId]: [...existing, newMessage] };
    });
    updateConversationList(selectedConvId, {
      lastMessage: trimmed,
      lastTime: timeLabel,
      unreadCount: 0,
    });
    setComposerValue("");
    requestAnimationFrame(adjustTextarea);

    if (shouldAutoScroll) {
      setPendingScroll(true);
    } else {
      setIsAtBottom(false);
    }
  }, [
    adjustTextarea,
    composerValue,
    isNearBottom,
    selectedConvId,
    updateConversationList,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleCopyAccountId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(accountFingerprint);
      push("Account ID copied.");
    } catch {
      push("Copy failed.");
    }
  }, [push]);

  const handleToggleRightPanel = useCallback(() => {
    if (!selectedConvId) return;
    setIsRightPanelOpen((prev) => !prev);
  }, [selectedConvId]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const handleChange = () => {
      if (media.matches) {
        setIsRightPanelOpen(false);
      }
    };
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!selectedConvId) return;
    requestAnimationFrame(() => {
      scrollToBottom();
      setIsAtBottom(true);
    });
  }, [scrollToBottom, selectedConvId]);

  useEffect(() => {
    if (!pendingScroll) return;
    requestAnimationFrame(() => {
      scrollToBottom();
      setPendingScroll(false);
      setIsAtBottom(true);
    });
  }, [pendingScroll, scrollToBottom, selectedMessages]);

  useEffect(() => {
    adjustTextarea();
  }, [adjustTextarea, composerValue]);

  const renderConversationItem = (conv: Conversation) => {
    const isSelected = selectedConvId === conv.id;
    const initials = conv.title
      .split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

    return (
      <button
        key={conv.id}
        type="button"
        className={`conversation-item${isSelected ? " selected" : ""}`}
        onClick={() => handleSelectConversation(conv.id)}
      >
        <div className="avatar small">{initials}</div>
        <div className="conversation-info">
          <div className="conversation-title">
            <span>{conv.title}</span>
            <span className="conversation-time">{conv.lastTime}</span>
          </div>
          <div className="conversation-meta">
            <span className="conversation-preview">{conv.lastMessage}</span>
            {conv.unreadCount > 0 ? (
              <span className="unread-badge">{conv.unreadCount}</span>
            ) : null}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className={`app-shell${isRightPanelOpen ? " right-open" : ""}`}>
      <aside className="left-rail">
        <div className="rail-top">
          <button type="button" className="avatar rail-avatar">
            TS
          </button>
          <button
            type="button"
            className="rail-button"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Settings"
          >
            <SettingsIcon width={18} height={18} />
          </button>
        </div>
        <div className="rail-nav">
          <button type="button" className="rail-button active">
            <MessageIcon width={18} height={18} />
          </button>
          <button type="button" className="rail-button">
            <UsersIcon width={18} height={18} />
          </button>
        </div>
        <div className="rail-spacer" />
        <button type="button" className="rail-button">
          <MoreIcon width={18} height={18} />
        </button>
      </aside>

      <aside className="left-panel">
        <div className="left-panel-header">
          <h2>메시지</h2>
          <div className="search-box">
            <SearchIcon width={16} height={16} />
            <input
              type="search"
              placeholder="검색"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
        </div>
        <div className="left-panel-scroll">
          <div className="panel-menu">
            {["새로운 메시지", "그룹 만들기", "커뮤니티 가입", "친구 초대"].map(
              (item) => (
                <button key={item} type="button" className="menu-action">
                  {item}
                </button>
              )
            )}
          </div>

          <div className="panel-section">
            <div className="section-title">연락처</div>
            <div className="contact-list">
              {contacts.map((contact) => (
                <div key={contact.id} className="contact-item">
                  <span className={`status-dot ${contact.status}`} />
                  <span>{contact.displayName}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">Pinned</div>
            <div className="conversation-list">
              {filteredPinned.length === 0 ? (
                <div className="empty-list">No pinned chats.</div>
              ) : (
                filteredPinned.map(renderConversationItem)
              )}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">All</div>
            <div className="conversation-list">
              {filteredConversations.length === 0 ? (
                <div className="empty-list">No conversations found.</div>
              ) : (
                filteredConversations.map(renderConversationItem)
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="main-chat">
        <div className="main-header">
          <div className="header-left">
            <button
              type="button"
              className="icon-button ghost"
              onClick={handleBack}
              aria-label="Back"
            >
              <BackIcon width={18} height={18} />
            </button>
            <div>
              <div className="header-title">
                {selectedConversation?.title ?? "대화를 선택하세요"}
              </div>
              <div className="header-sub">
                {selectedConversation?.lastSeen ?? "Select a conversation"}
              </div>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="icon-button"
              onClick={handleToggleRightPanel}
              disabled={!selectedConvId}
              aria-label="Toggle details"
            >
              <PanelIcon width={18} height={18} />
            </button>
          </div>
        </div>

        {selectedConversation ? (
          <>
            <div
              className="timeline"
              ref={timelineRef}
              onScroll={handleTimelineScroll}
            >
              <div className="timeline-inner">
                {selectedMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`message-row ${message.direction}`}
                  >
                    <div className="message-bubble">
                      <div className="message-body">{message.body}</div>
                      <div className="message-meta">{message.sentAt}</div>
                    </div>
                  </div>
                ))}
              </div>
              {!isAtBottom ? (
                <button
                  type="button"
                  className="scroll-bottom"
                  onClick={scrollToBottom}
                >
                  Scroll to bottom
                </button>
              ) : null}
            </div>
            <div className="composer">
              <div className="composer-inner">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder="메시지 입력..."
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <button
                  type="button"
                  className="send-button"
                  onClick={handleSend}
                  disabled={!composerValue.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h3>대화를 선택하세요</h3>
            <p>왼쪽에서 대화를 선택하면 메시지를 볼 수 있습니다.</p>
          </div>
        )}
      </main>

      <aside className="right-panel">
        {selectedConversation ? (
          <>
            <div className="detail-card">
              <div className="detail-title">Profile</div>
              <div className="detail-profile">
                <div className="avatar large">
                  {selectedConversation.title.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <strong>{selectedConversation.title}</strong>
                  <div className="muted">Last seen {selectedConversation.lastSeen}</div>
                </div>
              </div>
            </div>
            <div className="detail-card">
              <div className="detail-title">Memo</div>
              <p className="muted">
                Add a private note for this conversation.
              </p>
            </div>
            <div className="detail-card">
              <div className="detail-title">Settings</div>
              <button type="button" className="menu-action full">
                Mute notifications
              </button>
              <button type="button" className="menu-action full">
                Block conversation
              </button>
            </div>
          </>
        ) : (
          <div className="detail-empty">
            <p className="muted">Select a conversation to view details.</p>
          </div>
        )}
      </aside>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onCopyAccountId={handleCopyAccountId}
        displayName="TJR Session"
        accountId={accountFingerprint}
      />
      <Toast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
};

export default ChatScreen;
