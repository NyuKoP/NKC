
const root = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");
const toastRoot = document.getElementById("toast-root");

const STORAGE_KEY = "nkc_state_v1";

const PALETTE = [
  { id: "sky", color: "#4f7cff" },
  { id: "sage", color: "#34a0a4" },
  { id: "slate", color: "#64748b" },
  { id: "plum", color: "#8b5cf6" },
  { id: "rose", color: "#ec4899" },
  { id: "amber", color: "#f59e0b" },
];

const RIGHT_TABS = ["about", "media", "settings"];
const SCROLL_THRESHOLD = 48;
const GROUP_WINDOW_MS = 1000 * 60 * 2;
const MAX_MESSAGE_LENGTH = 240;
const MAX_TEXTAREA_HEIGHT = 160;
const DEBUG_EVENTS = true;

let timelineEl = null;

const state = {
  user: null,
  conversations: [],
  friends: [],
  ui: {
    selectedConversationId: null,
    rightPanelOpen: false,
    rightTab: "about",
    showHidden: false,
    searchQuery: "",
    listMode: "chats",
    toastQueue: [],
    modal: null,
    onboardingStep: "create",
    openMenuId: null,
    locked: false,
    pendingSecretKey: "",
    pendingDisplayName: "",
    pendingImportKey: "",
    photoFileName: "",
    isComposing: false,
  },
};

const icons = {
  chat: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 5h16v11H8l-4 4V5z"></path></svg>`,
  users: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6zm10 1a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM4 19c0-2.2 2-4 4.5-4S13 16.8 13 19H4zm9 0c0-1.8 1.4-3.3 3.3-3.7c2.2.2 3.7 1.6 3.7 3.7h-7z"></path></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3v2m0 14v2m-7-9h2m12 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M5.6 18.4l1.4-1.4m10-10l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z" /></svg>`,
  search: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zm9 16-4.2-4.2" /></svg>`,
  panel: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z" /></svg>`,
  back: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 6 4 12l6 6v-4h10v-4H10V6z" /></svg>`,
  dots: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 12h2m5 0h2m5 0h2" /></svg>`,
  lock: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 11h12v9H6zm2 0V8a4 4 0 0 1 8 0v3" /></svg>`,
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatTime = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

const pickPalette = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

const getInitials = (name) => {
  const trimmed = (name || "").trim();
  if (!trimmed) return "NK";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

const generateSecretKey = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const blocks = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0"));
  return `NKC-${blocks.slice(0, 4).join("")}-${blocks
    .slice(4, 8)
    .join("")}-${blocks.slice(8, 12).join("")}-${blocks
    .slice(12, 16)
    .join("")}`;
};

const createUser = ({ displayName, secretKey }) => {
  const palette = pickPalette();
  return {
    id: crypto.randomUUID(),
    displayName: displayName || "NKC 사용자",
    statusText: "NKC에서 온라인",
    theme: "light",
    secretKey,
    avatar: {
      type: "generated",
      color: palette.color,
      initials: getInitials(displayName || "NKC 사용자"),
      photoDataUrl: "",
    },
    createdAt: Date.now(),
  };
};

const buildMockFriends = () => [
  {
    id: "p1",
    displayName: "민지",
    statusText: "온라인",
    avatar: {
      type: "generated",
      color: "#94a3b8",
      initials: "민지",
      photoDataUrl: "",
    },
  },
  {
    id: "p2",
    displayName: "리드",
    statusText: "업무 중",
    avatar: {
      type: "generated",
      color: "#8b5cf6",
      initials: "RD",
      photoDataUrl: "",
    },
  },
  {
    id: "p3",
    displayName: "진아",
    statusText: "자리 비움",
    avatar: {
      type: "generated",
      color: "#f59e0b",
      initials: "진아",
      photoDataUrl: "",
    },
  },
];

const buildMockConversations = (user, friends = buildMockFriends()) => {
  const now = Date.now();
  const friendById = (id) => friends.find((friend) => friend.id === id);
  const minji = friendById("p1");
  const lead = friendById("p2");
  const jina = friendById("p3");
  return [
    {
      id: "c1",
      name: "민지",
      lastMessage: "오늘 4시에 연결할까요?",
      lastTime: now - 1000 * 60 * 5,
      unreadCount: 2,
      pinned: true,
      hidden: false,
      blockedOrMuted: null,
      participants: [
        user,
        { id: minji.id, displayName: minji.displayName, avatar: minji.avatar },
      ],
      messages: [
        {
          id: crypto.randomUUID(),
          senderId: "p1",
          text: "오늘 4시에 연결할까요?",
          ts: now - 1000 * 60 * 5,
        },
        {
          id: crypto.randomUUID(),
          senderId: user.id,
          text: "네, 일정 공유할게요.",
          ts: now - 1000 * 60 * 4,
        },
      ],
    },
    {
      id: "c2",
      name: "Orbit 팀",
      lastMessage: "릴리즈 노트 확인해주세요.",
      lastTime: now - 1000 * 60 * 30,
      unreadCount: 0,
      pinned: false,
      hidden: false,
      blockedOrMuted: "muted",
      participants: [
        user,
        { id: lead.id, displayName: lead.displayName, avatar: lead.avatar },
      ],
      messages: [
        {
          id: crypto.randomUUID(),
          senderId: "p2",
          text: "릴리즈 노트 확인해주세요.",
          ts: now - 1000 * 60 * 30,
        },
      ],
    },
    {
      id: "c3",
      name: "디자인 랩",
      lastMessage: "업데이트 공유했습니다.",
      lastTime: now - 1000 * 60 * 65,
      unreadCount: 1,
      pinned: false,
      hidden: false,
      blockedOrMuted: null,
      participants: [
        user,
        { id: jina.id, displayName: jina.displayName, avatar: jina.avatar },
      ],
      messages: [
        {
          id: crypto.randomUUID(),
          senderId: "p3",
          text: "업데이트 공유했습니다.",
          ts: now - 1000 * 60 * 65,
        },
      ],
    },
  ];
};

const dedupeByKey = (items, getKey) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const deriveFriendsFromConversations = (conversations, userId) => {
  const friendsMap = new Map();
  conversations.forEach((conv) => {
    conv.participants.forEach((participant) => {
      if (participant.id !== userId) {
        friendsMap.set(participant.id, participant);
      }
    });
  });
  return Array.from(friendsMap.values()).map((friend) => ({
    id: friend.id,
    displayName: friend.displayName,
    avatar: friend.avatar,
    statusText: "온라인",
  }));
};

const getFriendsList = () => {
  if (Array.isArray(state.friends) && state.friends.length) {
    return dedupeByKey(state.friends, (friend) => friend.id || friend.displayName);
  }
  if (!state.user) return [];
  return deriveFriendsFromConversations(state.conversations, state.user.id);
};

const getConversationByFriendId = (friendId) =>
  state.conversations.find((conv) =>
    conv.participants.some((participant) => participant.id === friendId)
  ) || null;

const saveState = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

const loadState = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved && saved.user) {
      state.user = saved.user;
      state.conversations = dedupeByKey(saved.conversations || [], (conv) => conv.id || conv.name);
      state.friends = dedupeByKey(saved.friends || [], (friend) => friend.id || friend.displayName);
      if (!state.friends.length) {
        state.friends = deriveFriendsFromConversations(state.conversations, state.user.id);
      }
      state.ui = {
        ...state.ui,
        ...saved.ui,
        modal: null,
        openMenuId: null,
        toastQueue: [],
        locked: false,
        photoFileName: "",
        isComposing: false,
      };
    }
  } catch (error) {
    // ignore
  }
};

const pushToast = (toast) => {
  state.ui.toastQueue.push({ id: crypto.randomUUID(), ...toast });
  renderToast();
  const currentId = state.ui.toastQueue.at(-1)?.id;
  window.setTimeout(() => {
    state.ui.toastQueue = state.ui.toastQueue.filter((item) => item.id !== currentId);
    renderToast();
  }, 2600);
};

const renderAvatar = (avatar, alt) => {
  if (avatar?.type === "photo" && avatar.photoDataUrl) {
    return `<span class="avatar"><img src="${avatar.photoDataUrl}" alt="${escapeHtml(
      alt
    )}" /></span>`;
  }
  return `<span class="avatar" style="background:${avatar?.color || "#64748b"}">${escapeHtml(
    avatar?.initials || "NK"
  )}</span>`;
};

const renderChatAvatar = (avatar, alt) => {
  if (avatar?.type === "photo" && avatar.photoDataUrl) {
    return `<span class="chat__avatar"><img src="${avatar.photoDataUrl}" alt="${escapeHtml(
      alt
    )}" /></span>`;
  }
  return `<span class="chat__avatar" style="background:${avatar?.color || "#64748b"}">${escapeHtml(
    avatar?.initials || "NK"
  )}</span>`;
};

const getConversationById = (id) =>
  state.conversations.find((conv) => conv.id === id) || null;

const groupMessages = (messages) => {
  const groups = [];
  messages.forEach((message) => {
    const last = groups.at(-1);
    const canGroup =
      last &&
      last.senderId === message.senderId &&
      message.ts - last.lastTs <= GROUP_WINDOW_MS;
    if (canGroup) {
      last.messages.push(message);
      last.lastTs = message.ts;
      return;
    }
    groups.push({
      senderId: message.senderId,
      messages: [message],
      lastTs: message.ts,
    });
  });
  return groups;
};

const isTimelineAtBottom = () => {
  if (!timelineEl) return true;
  return (
    timelineEl.scrollHeight -
      timelineEl.scrollTop -
      timelineEl.clientHeight <=
    SCROLL_THRESHOLD
  );
};

const scrollToBottom = () => {
  if (!timelineEl) return;
  timelineEl.scrollTop = timelineEl.scrollHeight;
  const button = document.getElementById("scroll-bottom");
  if (button) {
    button.classList.add("is-hidden");
  }
};

const bindTimeline = () => {
  const next = document.getElementById("chat-timeline");
  if (timelineEl === next) return;
  if (timelineEl) timelineEl.removeEventListener("scroll", handleTimelineScroll);
  timelineEl = next;
  if (timelineEl) timelineEl.addEventListener("scroll", handleTimelineScroll);
};

const handleTimelineScroll = () => {
  const button = document.getElementById("scroll-bottom");
  if (button) {
    button.classList.toggle("is-hidden", isTimelineAtBottom());
  }
};

const resizeComposer = (textarea) => {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(
    textarea.scrollHeight,
    MAX_TEXTAREA_HEIGHT
  )}px`;
};

const renderOnboarding = () => {
  const step = state.ui.onboardingStep;
  const secretKey = state.ui.pendingSecretKey || generateSecretKey();
  const displayName = state.ui.pendingDisplayName || "";
  const importKey = state.ui.pendingImportKey || "";

  state.ui.pendingSecretKey = secretKey;

  root.innerHTML = `
    <div class="app-shell">
      <section class="onboarding">
        <div class="onboarding__card">
          <div class="onboarding__title">
            <div>
              <h1>NKC 시작하기</h1>
              <p class="list-card__meta">비밀키로 계정을 안전하게 관리하세요.</p>
            </div>
            <span class="nkc-pill">NKC</span>
          </div>
          <div class="onboarding__tabs">
            <button class="${step === "create" ? "is-active" : ""}" data-action="onboarding-tab" data-step="create">새 계정</button>
            <button class="${step === "import" ? "is-active" : ""}" data-action="onboarding-tab" data-step="import">비밀키 로그인</button>
          </div>
          ${
            step === "create"
              ? `
            <div class="secret-key">
              <div>
                <strong>내 비밀키</strong>
                <p class="list-card__meta">이 키는 계정 접근의 유일한 방법입니다.</p>
              </div>
              <div class="secret-key__value">${escapeHtml(secretKey)}</div>
              <div class="secret-key__actions">
                <button class="btn btn--ghost" data-action="copy-secret" data-secret="${escapeHtml(
                  secretKey
                )}">복사</button>
                <button class="btn btn--ghost" data-action="download-secret" data-secret="${escapeHtml(
                  secretKey
                )}">파일로 저장</button>
                <button class="btn" data-action="regenerate-secret">새 키 생성</button>
              </div>
            </div>
            <label>
              표시 이름
              <input type="text" id="onboarding-name" placeholder="NKC 사용자" value="${escapeHtml(
                displayName
              )}" />
            </label>
            <button class="btn btn--primary" data-action="finish-create">이 키로 시작하기</button>
          `
              : `
            <div class="secret-key">
              <div>
                <strong>비밀키 가져오기</strong>
                <p class="list-card__meta">텍스트 입력 또는 파일 업로드로 복구합니다.</p>
              </div>
              <textarea id="import-key" rows="3" placeholder="NKC-XXXX-XXXX-XXXX-XXXX">${escapeHtml(
                importKey
              )}</textarea>
              <div class="secret-key__actions">
                <button class="btn btn--ghost" data-action="upload-secret">파일 가져오기</button>
                <input type="file" id="secret-file" class="is-hidden" accept=".txt" />
              </div>
            </div>
            <label>
              표시 이름
              <input type="text" id="import-name" placeholder="NKC 사용자" value="${escapeHtml(
                displayName
              )}" />
            </label>
            <button class="btn btn--primary" data-action="finish-import">로그인</button>
          `
          }
        </div>
      </section>
    </div>
  `;
};
const renderLeftRail = () => {
  const user = state.user;
  return `
    <aside class="left-rail">
      ${renderAvatar(user.avatar, user.displayName)
        .replace("avatar", "left-rail__avatar")
        .replace("<span", '<button data-action="open-settings"')
        .replace("</span>", "</button>")}
      <button class="left-rail__btn ${
        state.ui.listMode === "chats" ? "is-active" : ""
      }" data-action="set-list-mode" data-mode="chats">${icons.chat}</button>
      <button class="left-rail__btn ${
        state.ui.listMode === "friends" ? "is-active" : ""
      }" data-action="set-list-mode" data-mode="friends">${icons.users}</button>
      <div class="left-rail__spacer"></div>
      <button class="left-rail__btn" data-action="open-settings">${icons.settings}</button>
      <button class="left-rail__btn" data-action="lock">${icons.lock}</button>
    </aside>
  `;
};

const renderConversationItem = (conv) => {
  const isActive = state.ui.selectedConversationId === conv.id;
  const isHidden = conv.hidden;
  const statusBadge = conv.blockedOrMuted
    ? `<span class="status-pill">${conv.blockedOrMuted === "muted" ? "음소거" : "차단"}</span>`
    : "";
  const avatar = conv.participants.find((p) => p.id !== state.user.id)?.avatar;
  return `
    <div class="list-card ${isActive ? "is-active" : ""}" data-room="${conv.id}">
      ${renderAvatar(avatar, conv.name)}
      <div class="list-card__content">
        <div class="list-card__title truncate-1">${escapeHtml(conv.name)}</div>
        <div class="list-card__preview truncate-2">${escapeHtml(conv.lastMessage || "메시지 없음")}</div>
      </div>
      <div class="list-card__actions">
        <div class="list-card__time">${formatTime(conv.lastTime)}</div>
        ${conv.unreadCount > 0 ? `<span class="badge">${conv.unreadCount}</span>` : ""}
        ${statusBadge}
        <button class="btn btn--ghost" data-action="open-menu" data-room="${conv.id}">
          ${icons.dots}
        </button>
      </div>
      ${
        state.ui.openMenuId === conv.id
          ? `
        <div class="menu">
          <button data-action="hide-conversation" data-room="${conv.id}">${isHidden ? "숨김 해제" : "숨기기"}</button>
          <button data-action="mute-conversation" data-room="${conv.id}">${conv.blockedOrMuted === "muted" ? "음소거 해제" : "음소거"}</button>
          <button class="is-danger" data-action="delete-conversation" data-room="${conv.id}">삭제</button>
        </div>
      `
          : ""
      }
    </div>
  `;
};

const renderFriendItem = (friend) => {
  const conversation = getConversationByFriendId(friend.id);
  return `
    <div class="list-card" data-room="${conversation?.id || ""}" data-friend="${friend.id}">
      ${renderAvatar(friend.avatar, friend.displayName)}
      <div class="list-card__content">
        <div class="list-card__title truncate-1">${escapeHtml(friend.displayName)}</div>
        <div class="list-card__preview truncate-1">${escapeHtml(friend.statusText)}</div>
      </div>
      <div class="list-card__actions">
        <span class="status-pill">친구</span>
      </div>
    </div>
  `;
};

const renderLeftPanel = () => {
  const searchValue = escapeHtml(state.ui.searchQuery || "");
  const searchLower = (state.ui.searchQuery || "").trim().toLowerCase();
  const listMode = state.ui.listMode;
  const visibleConversations = state.conversations
    .filter((conv) => (state.ui.showHidden ? true : !conv.hidden))
    .filter((conv) => {
      if (!searchLower) return true;
      return (
        conv.name.toLowerCase().includes(searchLower) ||
        (conv.lastMessage || "").toLowerCase().includes(searchLower)
      );
    })
    .sort((a, b) => b.lastTime - a.lastTime);

  const pinned = visibleConversations.filter((conv) => conv.pinned);
  const regular = visibleConversations.filter((conv) => !conv.pinned);
  const hidden = state.conversations.filter((conv) => conv.hidden);
  const friends = getFriendsList().filter((friend) => {
    if (!searchLower) return true;
    return friend.displayName.toLowerCase().includes(searchLower);
  });

  return `
    <aside class="sidebar">
      <div class="sidebar__header">
        <div class="app-bar">
          <h1>NKC</h1>
          <div class="app-bar__actions">
            <button class="btn btn--ghost" data-action="open-settings">설정</button>
          </div>
        </div>
        <div class="profile">
          ${renderAvatar(state.user.avatar, state.user.displayName)}
          <div>
            <h2>${escapeHtml(state.user.displayName)}</h2>
            <p>${escapeHtml(state.user.statusText)}</p>
          </div>
          <button class="btn btn--ghost" data-action="open-settings">프로필</button>
        </div>
        <div class="segment">
          <button class="segment__btn ${
            listMode === "chats" ? "is-active" : ""
          }" data-action="set-list-mode" data-mode="chats">대화</button>
          <button class="segment__btn ${
            listMode === "friends" ? "is-active" : ""
          }" data-action="set-list-mode" data-mode="friends">친구</button>
        </div>
        <div class="sidebar__search">
          ${icons.search}
          <input id="search-input" type="search" placeholder="검색" value="${searchValue}" />
        </div>
      </div>
      <div class="sidebar__scroll">
        <details class="sidebar__menu">
          <summary>빠른 작업</summary>
          <button type="button">새 메시지</button>
          <button type="button">그룹 만들기</button>
          <button type="button">커뮤니티 참가</button>
          <button type="button">친구 초대</button>
        </details>
        ${
          listMode === "chats"
            ? `
          <div class="toggle-row">
            <span>숨김 항목 보기</span>
            <button class="btn btn--ghost" data-action="toggle-hidden">
              ${state.ui.showHidden ? "닫기" : "보기"}
            </button>
          </div>
          ${
            pinned.length
              ? `
            <div class="sidebar__section">
              <div class="section-title">Pinned</div>
              <div class="list">
                ${pinned.map(renderConversationItem).join("")}
              </div>
            </div>
          `
              : ""
          }
          <div class="sidebar__section">
            <div class="section-title">All</div>
            <div class="list">
              ${regular.length ? regular.map(renderConversationItem).join("") : `<div class="list-empty">대화가 없습니다.</div>`}
            </div>
          </div>
          ${
            state.ui.showHidden && hidden.length
              ? `
            <div class="sidebar__section">
              <div class="section-title">Hidden</div>
              <div class="list">
                ${hidden.map(renderConversationItem).join("")}
              </div>
            </div>
          `
              : ""
          }
        `
            : `
          <div class="sidebar__section">
          <div class="section-title">Friends</div>
          <div class="list">
              ${friends.length ? friends.map(renderFriendItem).join("") : `<div class="list-empty">친구가 없습니다.</div>`}
          </div>
        </div>
        `
        }
      </div>
    </aside>
  `;
};

const renderChat = () => {
  const conversation = state.ui.selectedConversationId
    ? getConversationById(state.ui.selectedConversationId)
    : null;
  const messages = conversation ? conversation.messages : [];
  const grouped = groupMessages(messages);

  return `
    <section class="chat">
      <div class="chat__header">
        <div class="chat__header-left">
          <button class="btn btn--ghost" data-action="back">${icons.back}</button>
          <div>
            <h3>${conversation ? escapeHtml(conversation.name) : "대화를 선택하세요"}</h3>
            <p>${conversation ? "최근 활동 2분 전" : "왼쪽에서 대화를 선택하세요."}</p>
          </div>
        </div>
        <div class="chat__header-actions">
          <button class="btn btn--ghost" data-action="toggle-right" ${conversation ? "" : "disabled"}>
            ${icons.panel}
          </button>
        </div>
      </div>
      <div class="chat__timeline" id="chat-timeline">
        ${
          conversation
            ? `
          <div class="chat__timeline-inner">
            ${grouped
              .map((group) => {
                const sender =
                  group.senderId === state.user.id
                    ? state.user
                    : conversation.participants.find((p) => p.id === group.senderId);
                const isMe = sender?.id === state.user.id;
                return `
                  <div class="chat__group ${isMe ? "chat__group--me" : ""}">
                    ${
                      isMe
                        ? ""
                        : renderChatAvatar(sender?.avatar, sender?.displayName || "상대")
                    }
                    <div class="chat__group-content">
                      ${isMe ? "" : `<div class="chat__name">${escapeHtml(sender?.displayName || "상대")}</div>`}
                      ${group.messages
                        .map(
                          (message) => `
                          <div class="chat__bubble ${isMe ? "is-me" : ""}">
                            ${escapeHtml(message.text)}
                            <span class="chat__time">${formatTime(message.ts)}</span>
                          </div>
                        `
                        )
                        .join("")}
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>
          <button class="scroll-button ${isTimelineAtBottom() ? "is-hidden" : ""}" id="scroll-bottom" data-action="scroll-bottom">맨 아래로</button>
        `
            : `
          <div class="chat__empty">
            <div class="chat__empty-icon">&#128172;</div>
            <h3>대화를 선택하세요</h3>
            <p>왼쪽 리스트에서 대화를 고르면 메시지가 보입니다.</p>
          </div>
        `
        }
      </div>
      <form class="chat__composer ${conversation ? "" : "is-disabled"}" id="chat-form">
        <textarea id="chat-input" name="message" rows="1" maxlength="${MAX_MESSAGE_LENGTH}" placeholder="메시지 입력..." ${
    conversation ? "" : "disabled"
  }>${escapeHtml(state.ui.composerText || "")}</textarea>
        <div class="chat__composer-actions">
          <span id="char-count">${(state.ui.composerText || "").length} / ${MAX_MESSAGE_LENGTH}</span>
          <button class="btn btn--primary" type="submit" ${conversation && state.ui.composerText?.trim() ? "" : "disabled"}>전송</button>
        </div>
      </form>
    </section>
  `;
};

const renderRightPanel = () => {
  const conversation = state.ui.selectedConversationId
    ? getConversationById(state.ui.selectedConversationId)
    : null;
  const partner =
    conversation?.participants.find((p) => p.id !== state.user.id) || null;

  return `
    <aside class="right-panel ${state.ui.rightPanelOpen && conversation ? "" : "is-hidden"}">
      <div class="right-panel__tabs">
        ${RIGHT_TABS.map(
          (tab) => `
            <button class="${state.ui.rightTab === tab ? "is-active" : ""}" data-action="switch-tab" data-tab="${tab}">
              ${tab === "about" ? "About" : tab === "media" ? "Media" : "Settings"}
            </button>
          `
        ).join("")}
      </div>
      ${
        conversation
          ? `
        <div class="right-panel__card">
          <div class="section-title">프로필</div>
          <div class="right-panel__profile">
            ${renderAvatar(partner?.avatar, partner?.displayName || "상대")}
            <div>
              <div class="right-panel__name">${escapeHtml(partner?.displayName || "상대")}</div>
              <div class="right-panel__status">상태: 활성</div>
            </div>
          </div>
        </div>
        <div class="right-panel__card">
          <div class="section-title">메모</div>
          <p class="list-card__meta">이 대화에 대한 메모를 남기세요.</p>
        </div>
      `
          : `
        <div class="right-panel__card">
          <div class="section-title">상세 정보</div>
          <p class="list-card__meta">대화를 선택하면 정보가 표시됩니다.</p>
        </div>
      `
      }
    </aside>
  `;
};

const renderModal = () => {
  if (!state.ui.modal) {
    modalRoot.innerHTML = "";
    return;
  }

  if (state.ui.modal.type === "confirm") {
    modalRoot.innerHTML = `
      <div class="modal">
        <div class="modal__overlay" data-action="close-modal"></div>
        <div class="modal__content">
          <div class="modal__header">
            <h2>${escapeHtml(state.ui.modal.title)}</h2>
          </div>
          <p class="list-card__meta">${escapeHtml(state.ui.modal.message)}</p>
          <div class="modal__footer">
            <button class="btn btn--ghost" data-action="close-modal">취소</button>
            <button class="btn btn--danger" data-action="confirm-modal">확인</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (state.ui.modal.type === "settings") {
    modalRoot.innerHTML = `
      <div class="modal">
        <div class="modal__overlay" data-action="close-modal"></div>
        <div class="modal__content">
          <div class="modal__header">
            <h2>NKC 설정</h2>
            <button class="btn btn--ghost" type="button" data-action="close-modal">닫기</button>
          </div>
          <form id="settings-form">
            <div class="modal__section">
              <div class="modal__section-title">프로필</div>
              <div class="modal__profile">
                <div class="modal__avatar">
                  ${renderAvatar(state.user.avatar, state.user.displayName)}
                </div>
                <div class="modal__profile-fields">
                  <label>
                    표시 이름
                    <input name="displayName" type="text" value="${escapeHtml(
                      state.user.displayName
                    )}" />
                  </label>
                  <label>
                    상태 메시지
                    <input name="statusText" type="text" value="${escapeHtml(
                      state.user.statusText
                    )}" />
                  </label>
                </div>
              </div>
              <label>
                프로필 사진
                <input type="file" id="photo-input" accept="image/*" />
              </label>
              ${
                state.ui.photoFileName
                  ? `<span class="file-name">${escapeHtml(state.ui.photoFileName)}</span>`
                  : ""
              }
            </div>
            <div class="modal__section">
              <div class="modal__section-title">비밀키</div>
              <div class="secret-key">
                <strong>내 비밀키</strong>
                <div class="secret-key__value">${escapeHtml(
                  state.user.secretKey
                )}</div>
                <div class="secret-key__actions">
                  <button class="btn btn--ghost" type="button" data-action="copy-secret" data-secret="${escapeHtml(
                    state.user.secretKey
                  )}">복사</button>
                  <button class="btn btn--ghost" type="button" data-action="download-secret" data-secret="${escapeHtml(
                    state.user.secretKey
                  )}">파일로 저장</button>
                </div>
              </div>
            </div>
            <div class="modal__section">
              <div class="modal__section-title">디자인 (선택)</div>
              <label>
                테마
                <select name="theme">
                  <option value="light" ${state.user.theme === "light" ? "selected" : ""}>라이트</option>
                  <option value="dark" ${state.user.theme === "dark" ? "selected" : ""}>다크</option>
                </select>
              </label>
            </div>
            <div class="modal__footer">
              <button class="btn btn--ghost" type="button" data-action="close-modal">닫기</button>
              <button class="btn btn--primary" type="submit">저장</button>
            </div>
          </form>
          <div class="modal__danger">
            <div>
              <strong>로그아웃</strong>
              <p class="list-card__meta">비밀키를 잃으면 복구할 수 없습니다.</p>
            </div>
            <button class="btn btn--danger" data-action="logout">로그아웃</button>
          </div>
        </div>
      </div>
    `;
  }
};

const renderToast = () => {
  if (!state.ui.toastQueue.length) {
    toastRoot.innerHTML = "";
    return;
  }
  toastRoot.innerHTML = `
    <div class="toast-stack">
      ${state.ui.toastQueue
        .map(
          (toast) => `
          <div class="toast">
            <span>${escapeHtml(toast.message)}</span>
            ${
              toast.action
                ? `
              <div class="toast__actions">
                <button class="btn btn--ghost" data-action="toast-action" data-toast="${toast.id}">
                  ${toast.actionLabel}
                </button>
              </div>
            `
                : ""
            }
          </div>
        `
        )
        .join("")}
    </div>
  `;
};

const renderApp = () => {
  if (!state.user) {
    renderOnboarding();
    renderModal();
    renderToast();
    return;
  }

  root.innerHTML = `
    <div class="app-shell">
      <div class="layout">
        ${renderLeftRail()}
        ${renderLeftPanel()}
        ${renderChat()}
        ${renderRightPanel()}
      </div>
    </div>
  `;
  bindTimeline();
  resizeComposer(document.getElementById("chat-input"));
  renderModal();
  renderToast();
};

const handleCopySecret = async (secret) => {
  try {
    await navigator.clipboard.writeText(secret);
    pushToast({ message: "비밀키가 복사되었습니다." });
  } catch (error) {
    pushToast({ message: "복사에 실패했습니다." });
  }
};

const handleDownloadSecret = (secret) => {
  const blob = new Blob([secret], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "nkc-secret-key.txt";
  link.click();
  URL.revokeObjectURL(url);
  pushToast({ message: "비밀키 파일을 저장했습니다." });
};

const handleCreateAccount = () => {
  const nameInput = document.getElementById("onboarding-name");
  const displayName = nameInput?.value.trim() || "NKC 사용자";
  const secretKey = state.ui.pendingSecretKey || generateSecretKey();
  state.user = createUser({ displayName, secretKey });
  state.friends = buildMockFriends();
  state.conversations = buildMockConversations(state.user, state.friends);
  state.ui.selectedConversationId = null;
  state.ui.onboardingStep = "create";
  saveState();
  renderApp();
};

const handleImportAccount = () => {
  const nameInput = document.getElementById("import-name");
  const keyInput = document.getElementById("import-key");
  const displayName = nameInput?.value.trim() || "NKC 사용자";
  const secretKey = keyInput?.value.trim();
  if (!secretKey) {
    pushToast({ message: "비밀키를 입력하세요." });
    return;
  }
  state.user = createUser({ displayName, secretKey });
  state.friends = buildMockFriends();
  state.conversations = buildMockConversations(state.user, state.friends);
  state.ui.selectedConversationId = null;
  saveState();
  renderApp();
};

const handleLock = () => {
  state.ui.locked = true;
  state.ui.modal = {
    type: "confirm",
    title: "잠금 상태",
    message: "비밀키로 다시 해제할 수 있습니다.",
    onConfirm: null,
  };
  renderModal();
};

const handleSendMessage = () => {
  const conversation = getConversationById(state.ui.selectedConversationId);
  if (!conversation) return;
  if (state.ui.isComposing) return;
  const text = (state.ui.composerText || "").trim();
  if (!text) return;
  const shouldAutoScroll = isTimelineAtBottom();
  const message = {
    id: crypto.randomUUID(),
    senderId: state.user.id,
    text,
    ts: Date.now(),
  };
  conversation.messages.push(message);
  conversation.lastMessage = text;
  conversation.lastTime = message.ts;
  conversation.unreadCount = 0;
  state.ui.composerText = "";
  saveState();
  renderApp();
  if (shouldAutoScroll) {
    requestAnimationFrame(scrollToBottom);
  }
  simulateReply(conversation.id);
};

const simulateReply = (conversationId) => {
  const conversation = getConversationById(conversationId);
  if (!conversation) return;
  const partner = conversation.participants.find((p) => p.id !== state.user.id);
  const delay = 600 + Math.floor(Math.random() * 600);
  window.setTimeout(() => {
    const reply = {
      id: crypto.randomUUID(),
      senderId: partner?.id || "partner",
      text: "확인했어요. 곧 답장할게요.",
      ts: Date.now(),
    };
    conversation.messages.push(reply);
    conversation.lastMessage = reply.text;
    conversation.lastTime = reply.ts;
    if (state.ui.selectedConversationId !== conversationId) {
      conversation.unreadCount += 1;
      saveState();
      renderApp();
      return;
    }
    saveState();
    const shouldAutoScroll = isTimelineAtBottom();
    renderApp();
    if (shouldAutoScroll) {
      requestAnimationFrame(scrollToBottom);
    }
  }, delay);
};

const handleConversationSelect = (conversationId) => {
  state.ui.selectedConversationId = conversationId;
  const conversation = getConversationById(conversationId);
  if (conversation) conversation.unreadCount = 0;
  state.ui.openMenuId = null;
  saveState();
  renderApp();
  requestAnimationFrame(scrollToBottom);
};

const handleBack = () => {
  state.ui.selectedConversationId = null;
  state.ui.rightPanelOpen = false;
  state.ui.openMenuId = null;
  saveState();
  renderApp();
};

const handleHideConversation = (conversationId) => {
  const conversation = getConversationById(conversationId);
  if (!conversation) return;
  const wasHidden = conversation.hidden;
  conversation.hidden = !conversation.hidden;
  state.ui.openMenuId = null;
  saveState();
  renderApp();
  pushToast({
    message: wasHidden ? "숨김을 해제했어요." : "대화를 숨겼어요.",
    actionLabel: "Undo",
    action: () => {
      conversation.hidden = wasHidden;
      saveState();
      renderApp();
    },
  });
};

const handleMuteConversation = (conversationId) => {
  const conversation = getConversationById(conversationId);
  if (!conversation) return;
  conversation.blockedOrMuted =
    conversation.blockedOrMuted === "muted" ? null : "muted";
  state.ui.openMenuId = null;
  saveState();
  renderApp();
  pushToast({
    message: conversation.blockedOrMuted ? "음소거했어요." : "음소거를 해제했어요.",
  });
};
const handleDeleteConversation = (conversationId) => {
  const conversation = getConversationById(conversationId);
  if (!conversation) return;
  state.ui.modal = {
    type: "confirm",
    title: "대화를 삭제할까요?",
    message: "삭제하면 복구가 제한됩니다.",
    onConfirm: () => {
      const index = state.conversations.findIndex((conv) => conv.id === conversationId);
      const removed = state.conversations.splice(index, 1)[0];
      state.ui.selectedConversationId = null;
      state.ui.openMenuId = null;
      state.ui.modal = null;
      saveState();
      renderApp();
      pushToast({
        message: "대화를 삭제했어요.",
        actionLabel: "Undo",
        action: () => {
          state.conversations.splice(index, 0, removed);
          saveState();
          renderApp();
        },
      });
    },
  };
  renderModal();
};

const handleLogout = () => {
  state.ui.modal = {
    type: "confirm",
    title: "로그아웃할까요?",
    message: "비밀키를 잃으면 복구할 수 없습니다.",
    onConfirm: () => {
      localStorage.removeItem(STORAGE_KEY);
      state.user = null;
      state.conversations = [];
      state.ui = {
        ...state.ui,
        selectedConversationId: null,
        rightPanelOpen: false,
        toastQueue: [],
        modal: null,
        onboardingStep: "create",
      };
      renderApp();
    },
  };
  renderModal();
};

const handleSettingsSubmit = (form) => {
  const displayName = form.displayName.value.trim() || "NKC 사용자";
  state.user.displayName = displayName;
  state.user.statusText = form.statusText.value.trim() || "NKC에서 온라인";
  state.user.theme = form.theme.value;
  if (state.user.avatar.type === "generated") {
    state.user.avatar.initials = getInitials(displayName);
  }
  document.documentElement.setAttribute("data-theme", state.user.theme);
  saveState();
  pushToast({ message: "프로필을 저장했습니다." });
  renderApp();
};

const handlePhotoUpload = (file) => {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.user.avatar = {
      type: "photo",
      color: state.user.avatar.color,
      initials: state.user.avatar.initials,
      photoDataUrl: reader.result,
    };
    saveState();
    renderApp();
  };
  reader.readAsDataURL(file);
};

const handleDocumentClick = (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const actionTarget = target.closest("[data-action]");
  const action = actionTarget?.dataset.action;
  if (action) {
    if (action === "onboarding-tab") {
      state.ui.onboardingStep = actionTarget.dataset.step;
      renderOnboarding();
      return;
    }
    if (action === "copy-secret") {
      handleCopySecret(actionTarget.dataset.secret);
      return;
    }
    if (action === "download-secret") {
      handleDownloadSecret(actionTarget.dataset.secret);
      return;
    }
    if (action === "regenerate-secret") {
      state.ui.pendingSecretKey = generateSecretKey();
      renderOnboarding();
      return;
    }
    if (action === "finish-create") {
      handleCreateAccount();
      return;
    }
    if (action === "finish-import") {
      handleImportAccount();
      return;
    }
    if (action === "upload-secret") {
      document.getElementById("secret-file")?.click();
      return;
    }
    if (action === "open-settings") {
      state.ui.photoFileName = "";
      state.ui.modal = { type: "settings" };
      renderModal();
      return;
    }
    if (action === "close-modal") {
      state.ui.modal = null;
      renderModal();
      return;
    }
    if (action === "confirm-modal") {
      const handler = state.ui.modal?.onConfirm;
      state.ui.modal = null;
      renderModal();
      if (handler) handler();
      return;
    }
    if (action === "logout") {
      handleLogout();
      return;
    }
    if (action === "toggle-right") {
      if (!state.ui.selectedConversationId) return;
      state.ui.rightPanelOpen = !state.ui.rightPanelOpen;
      saveState();
      renderApp();
      return;
    }
    if (action === "back") {
      handleBack();
      return;
    }
    if (action === "scroll-bottom") {
      scrollToBottom();
      return;
    }
    if (action === "open-menu") {
      const roomId = actionTarget.dataset.room;
      state.ui.openMenuId = state.ui.openMenuId === roomId ? null : roomId;
      renderApp();
      return;
    }
    if (action === "hide-conversation") {
      handleHideConversation(actionTarget.dataset.room);
      return;
    }
    if (action === "mute-conversation") {
      handleMuteConversation(actionTarget.dataset.room);
      return;
    }
    if (action === "delete-conversation") {
      handleDeleteConversation(actionTarget.dataset.room);
      return;
    }
    if (action === "toggle-hidden") {
      state.ui.showHidden = !state.ui.showHidden;
      saveState();
      renderApp();
      return;
    }
    if (action === "lock") {
      handleLock();
      return;
    }
    if (action === "switch-tab") {
      state.ui.rightTab = actionTarget.dataset.tab;
      saveState();
      renderApp();
      return;
    }
    if (action === "toast-action") {
      const toast = state.ui.toastQueue.find(
        (item) => item.id === actionTarget.dataset.toast
      );
      if (toast?.action) toast.action();
      state.ui.toastQueue = state.ui.toastQueue.filter(
        (item) => item.id !== toast.id
      );
      renderToast();
      return;
    }
    if (action === "set-list-mode") {
      state.ui.listMode = actionTarget.dataset.mode;
      saveState();
      renderApp();
      return;
    }
  }

  const roomTarget = target.closest("[data-room]");
  if (roomTarget && roomTarget.dataset.room) {
    handleConversationSelect(roomTarget.dataset.room);
    return;
  }

  const friendTarget = target.closest("[data-friend]");
  if (friendTarget) {
    const conversation = getConversationByFriendId(friendTarget.dataset.friend);
    if (conversation) {
      handleConversationSelect(conversation.id);
      return;
    }
    pushToast({ message: "대화를 시작할 친구를 선택하세요." });
    return;
  }

};

const handleDocumentInput = (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.id === "search-input") {
    state.ui.searchQuery = target.value;
    if (event.isComposing) return;
    const selectionStart = target.selectionStart;
    const selectionEnd = target.selectionEnd;
    const wasFocused = document.activeElement === target;
    saveState();
    renderApp();
    if (wasFocused) {
      const next = document.getElementById("search-input");
      if (next && selectionStart !== null && selectionEnd !== null) {
        next.focus();
        next.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  if (target.id === "chat-input") {
    state.ui.composerText = target.value.slice(0, MAX_MESSAGE_LENGTH);
    resizeComposer(target);
    const count = document.getElementById("char-count");
    if (count) count.textContent = `${state.ui.composerText.length} / ${MAX_MESSAGE_LENGTH}`;
    const sendButton = document.querySelector('#chat-form button[type="submit"]');
    if (sendButton) {
      sendButton.disabled =
        !state.ui.selectedConversationId || !state.ui.composerText.trim();
    }
  }
  if (target.id === "onboarding-name") {
    state.ui.pendingDisplayName = target.value;
  }
  if (target.id === "import-name") {
    state.ui.pendingDisplayName = target.value;
  }
  if (target.id === "import-key") {
    state.ui.pendingImportKey = target.value;
  }
};

const handleDocumentChange = (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.id === "secret-file") {
    const file = target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.ui.pendingImportKey = reader.result?.toString() || "";
      renderOnboarding();
    };
    reader.readAsText(file);
  }
  if (target.id === "photo-input") {
    const file = target.files?.[0];
    state.ui.photoFileName = file?.name || "";
    handlePhotoUpload(file);
  }
};

const handleDocumentSubmit = (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.id === "chat-form") {
    event.preventDefault();
    if (state.ui.isComposing) return;
    handleSendMessage();
  }
  if (target.id === "settings-form") {
    event.preventDefault();
    handleSettingsSubmit(target);
  }
};

const handleDocumentKeydown = (event) => {
  if (event.key === "Escape" && state.ui.modal) {
    state.ui.modal = null;
    renderModal();
  }
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.id === "chat-input" && event.key === "Enter" && !event.shiftKey) {
    if (event.isComposing || state.ui.isComposing) return;
    event.preventDefault();
    target.form.requestSubmit();
  }
};

const handleCompositionEvent = (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.id === "chat-input") {
    state.ui.isComposing = event.type === "compositionstart";
  }
};

const logClick = (event) => {
  if (!DEBUG_EVENTS) return;
  const path = event.composedPath ? event.composedPath() : [];
  const sample = path.slice(0, 4);
  console.log("CLICK", event.target, sample);
};

document.addEventListener("click", logClick, true);
document.addEventListener("click", handleDocumentClick);
document.addEventListener("input", handleDocumentInput);
document.addEventListener("compositionstart", handleCompositionEvent);
document.addEventListener("compositionend", handleCompositionEvent);
document.addEventListener("change", handleDocumentChange);
document.addEventListener("submit", handleDocumentSubmit);
document.addEventListener("keydown", handleDocumentKeydown);

const boot = () => {
  loadState();
  if (state.user) {
    document.documentElement.setAttribute("data-theme", state.user.theme || "light");
  }
  renderApp();
};

boot();
