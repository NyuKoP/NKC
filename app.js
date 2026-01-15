const authView = document.getElementById("auth");
const mainView = document.getElementById("main");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const loginError = document.getElementById("login-error");
const signupError = document.getElementById("signup-error");
const authTabButtons = document.querySelectorAll("[data-auth-tab]");
const friendsList = document.getElementById("friends-list");
const chatsList = document.getElementById("chats-list");
const profileName = document.getElementById("profile-name");
const profileStatus = document.getElementById("profile-status");
const profileAvatar = document.getElementById("profile-avatar");
const chatTitle = document.getElementById("chat-title");
const chatTimeline = document.getElementById("chat-timeline");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const charCount = document.getElementById("char-count");
const settingsModal = document.getElementById("settings-modal");
const settingsOpen = document.getElementById("settings-open");
const settingsForm = document.getElementById("settings-form");
const avatarGrid = document.getElementById("avatar-grid");
const logoutBtn = document.getElementById("logout-btn");

const STORAGE_KEYS = {
  users: "users",
  session: "session",
  appState: "appState",
  rooms: "rooms",
};

const AVATAR_PRESETS = [
  { id: "sky", label: "SK", color: "#4f7cff" },
  { id: "sage", label: "SG", color: "#34a0a4" },
  { id: "slate", label: "SL", color: "#64748b" },
  { id: "plum", label: "PL", color: "#8b5cf6" },
  { id: "rose", label: "RS", color: "#ec4899" },
  { id: "amber", label: "AM", color: "#f59e0b" },
];

const DEFAULT_ROOMS = () => ({
  r1: {
    id: "r1",
    title: "민지",
    members: ["me", "minji"],
    unread: 1,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "other",
        text: "오늘 일정 확인해 줄 수 있어?",
        ts: Date.now() - 1000 * 60 * 8,
      },
    ],
  },
  r2: {
    id: "r2",
    title: "프로젝트 A",
    members: ["me", "team"],
    unread: 2,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "system",
        text: "새로운 공지가 있습니다.",
        ts: Date.now() - 1000 * 60 * 50,
      },
    ],
  },
  r3: {
    id: "r3",
    title: "디자인 팀",
    members: ["me", "design"],
    unread: 0,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "other",
        text: "피그마 업데이트했어!",
        ts: Date.now() - 1000 * 60 * 90,
      },
    ],
  },
});

const defaultState = {
  activeTab: "friends",
  activeRoomId: "r1",
};

const store = {
  users: [],
  session: null,
  appState: { ...defaultState },
  rooms: DEFAULT_ROOMS(),
};

const readStorage = (key, fallback) => {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
};

const writeStorage = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const initStore = () => {
  store.users = readStorage(STORAGE_KEYS.users, []);
  store.session = readStorage(STORAGE_KEYS.session, null);
  store.appState = readStorage(STORAGE_KEYS.appState, { ...defaultState });
  store.rooms = readStorage(STORAGE_KEYS.rooms, DEFAULT_ROOMS());
};

const saveStore = () => {
  writeStorage(STORAGE_KEYS.users, store.users);
  writeStorage(STORAGE_KEYS.session, store.session);
  writeStorage(STORAGE_KEYS.appState, store.appState);
  writeStorage(STORAGE_KEYS.rooms, store.rooms);
};

const switchView = (isAuthenticated) => {
  authView.classList.toggle("is-hidden", isAuthenticated);
  mainView.classList.toggle("is-hidden", !isAuthenticated);
};

const validateEmail = (email) => /.+@.+\..+/.test(email);

const findUserByEmail = (email) =>
  store.users.find((user) => user.email === email);

const getCurrentUser = () =>
  store.users.find((user) => user.id === store.session?.userId) ?? null;

const buildAvatar = (target, avatarId, username) => {
  const preset = AVATAR_PRESETS.find((item) => item.id === avatarId) ??
    AVATAR_PRESETS[0];
  target.style.background = preset.color;
  target.textContent = username?.slice(0, 2).toUpperCase() || preset.label;
};

const renderFriends = () => {
  const friends = [
    { id: "f1", name: "민지", status: "오늘은 재택" },
    { id: "f2", name: "지훈", status: "디자인 검토 중" },
    { id: "f3", name: "유나", status: "회의 준비" },
  ];
  friendsList.innerHTML = friends
    .map(
      (friend) => `
      <div class="list-card">
        <div class="avatar" style="background:#9ca3af">${friend.name.slice(0, 1)}</div>
        <div>
          <div class="list-card__name">${friend.name}</div>
          <div class="list-card__meta">${friend.status}</div>
        </div>
        <span class="list-card__meta">온라인</span>
      </div>
    `,
    )
    .join("");
};

const formatTime = (ts) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));

const renderChats = () => {
  const rooms = Object.values(store.rooms);
  chatsList.innerHTML = rooms
    .map((room) => {
      const lastMessage = room.messages.at(-1);
      return `
      <div class="list-card ${room.id === store.appState.activeRoomId ? "is-active" : ""}" data-room="${room.id}">
        <div class="avatar" style="background:#94a3b8">${room.title.slice(0, 1)}</div>
        <div>
          <div class="list-card__name">${room.title}</div>
          <div class="list-card__meta">${lastMessage?.text ?? "메시지가 없습니다."}</div>
        </div>
        <div>
          <div class="list-card__meta">${lastMessage ? formatTime(lastMessage.ts) : ""}</div>
          ${room.unread > 0 ? `<span class="badge">${room.unread}</span>` : ""}
        </div>
      </div>
    `;
    })
    .join("");
};

const renderChatRoom = () => {
  const room = store.rooms[store.appState.activeRoomId];
  if (!room) return;
  chatTitle.textContent = room.title;
  chatTimeline.innerHTML = room.messages
    .map(
      (message) => `
      <div>
        <div class="chat__bubble ${message.role === "me" ? "is-me" : ""}">
          ${message.text}
        </div>
        <div class="chat__meta">${formatTime(message.ts)}</div>
      </div>
    `,
    )
    .join("");
  chatTimeline.scrollTop = chatTimeline.scrollHeight;
};

const updateTabs = () => {
  document.querySelectorAll(".segment__btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === store.appState.activeTab);
  });
  friendsList.classList.toggle("is-hidden", store.appState.activeTab !== "friends");
  chatsList.classList.toggle("is-hidden", store.appState.activeTab !== "chats");
};

const setActiveRoom = (roomId) => {
  store.appState.activeRoomId = roomId;
  const room = store.rooms[roomId];
  if (room) {
    room.unread = 0;
  }
  saveStore();
  renderChats();
  renderChatRoom();
};

const seedDemoUser = () => {
  if (store.users.length > 0) return;
  store.users.push({
    id: crypto.randomUUID(),
    username: "데모",
    email: "demo@example.com",
    passwordPlainForDemo: "password",
    avatarId: AVATAR_PRESETS[0].id,
    status: "로컬 데모 계정",
    theme: "light",
  });
  saveStore();
};

const applyUserProfile = () => {
  const user = getCurrentUser();
  if (!user) return;
  profileName.textContent = user.username;
  profileStatus.textContent = user.status || "상태 메시지를 설정해 보세요.";
  buildAvatar(profileAvatar, user.avatarId, user.username);
};

const applyTheme = () => {
  const user = getCurrentUser();
  const theme = user?.theme || "light";
  document.documentElement.setAttribute("data-theme", theme);
};

const updateCharCount = () => {
  const length = chatInput.value.length;
  charCount.textContent = `${length} / 240`;
};

const openSettings = () => {
  settingsModal.classList.remove("is-hidden");
  settingsModal.setAttribute("aria-hidden", "false");
  const user = getCurrentUser();
  if (!user) return;
  settingsForm.username.value = user.username;
  settingsForm.status.value = user.status;
  settingsForm.theme.value = user.theme || "light";
  document.querySelectorAll(".avatar-option").forEach((option) => {
    option.classList.toggle("is-selected", option.dataset.avatar === user.avatarId);
  });
};

const closeSettings = () => {
  settingsModal.classList.add("is-hidden");
  settingsModal.setAttribute("aria-hidden", "true");
};

const renderAvatarOptions = () => {
  avatarGrid.innerHTML = AVATAR_PRESETS
    .map(
      (preset) => `
      <button type="button" class="avatar-option" data-avatar="${preset.id}">
        <span class="avatar__chip" style="background:${preset.color}">${preset.label}</span>
        <span>${preset.id}</span>
      </button>
    `,
    )
    .join("");
};

const handleAuthTab = (target) => {
  authTabButtons.forEach((button) => button.classList.remove("is-active"));
  target.classList.add("is-active");
  const isLogin = target.dataset.authTab === "login";
  document.getElementById("login-panel").classList.toggle("is-hidden", !isLogin);
  document.getElementById("signup-panel").classList.toggle("is-hidden", isLogin);
};

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const { email, password } = Object.fromEntries(new FormData(loginForm));
  if (!validateEmail(email)) {
    loginError.textContent = "이메일 형식이 올바르지 않습니다.";
    return;
  }
  if (password.length < 6) {
    loginError.textContent = "비밀번호는 6자 이상이어야 합니다.";
    return;
  }
  const user = findUserByEmail(email);
  if (!user || user.passwordPlainForDemo !== password) {
    loginError.textContent = "이메일 또는 비밀번호가 일치하지 않습니다.";
    return;
  }
  store.session = { userId: user.id };
  saveStore();
  applyTheme();
  applyUserProfile();
  renderChats();
  renderChatRoom();
  switchView(true);
});

signupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  signupError.textContent = "";
  const { username, email, password } = Object.fromEntries(new FormData(signupForm));
  if (!username || username.length < 2) {
    signupError.textContent = "사용자 이름은 2자 이상이어야 합니다.";
    return;
  }
  if (!validateEmail(email)) {
    signupError.textContent = "이메일 형식이 올바르지 않습니다.";
    return;
  }
  if (password.length < 6) {
    signupError.textContent = "비밀번호는 6자 이상이어야 합니다.";
    return;
  }
  if (findUserByEmail(email)) {
    signupError.textContent = "이미 가입된 이메일입니다.";
    return;
  }
  const newUser = {
    id: crypto.randomUUID(),
    username,
    email,
    passwordPlainForDemo: password,
    avatarId: AVATAR_PRESETS[1].id,
    status: "새로운 사용자",
    theme: "light",
  };
  store.users.push(newUser);
  store.session = { userId: newUser.id };
  saveStore();
  applyTheme();
  applyUserProfile();
  renderChats();
  renderChatRoom();
  switchView(true);
});

settingsOpen.addEventListener("click", openSettings);
settingsModal.addEventListener("click", (event) => {
  if (event.target.dataset.close) {
    closeSettings();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettings();
  }
});

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;
  const username = settingsForm.username.value.trim();
  const status = settingsForm.status.value.trim();
  if (username.length < 2 || username.length > 20) {
    return;
  }
  user.username = username;
  user.status = status.slice(0, 60);
  user.theme = settingsForm.theme.value;
  const selectedAvatar = document.querySelector(".avatar-option.is-selected");
  if (selectedAvatar) {
    user.avatarId = selectedAvatar.dataset.avatar;
  }
  saveStore();
  applyTheme();
  applyUserProfile();
  renderChats();
  closeSettings();
});

logoutBtn.addEventListener("click", () => {
  store.session = null;
  saveStore();
  switchView(false);
});

avatarGrid.addEventListener("click", (event) => {
  const button = event.target.closest(".avatar-option");
  if (!button) return;
  document.querySelectorAll(".avatar-option").forEach((option) => {
    option.classList.toggle("is-selected", option === button);
  });
});

document.querySelectorAll(".segment__btn").forEach((button) => {
  button.addEventListener("click", () => {
    store.appState.activeTab = button.dataset.tab;
    saveStore();
    updateTabs();
  });
});

chatsList.addEventListener("click", (event) => {
  const card = event.target.closest(".list-card");
  if (!card) return;
  setActiveRoom(card.dataset.room);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const room = store.rooms[store.appState.activeRoomId];
  if (!room) return;
  room.messages.push({
    id: crypto.randomUUID(),
    role: "me",
    text,
    ts: Date.now(),
  });
  saveStore();
  chatInput.value = "";
  updateCharCount();
  renderChats();
  renderChatRoom();
  const delay = 700 + Math.floor(Math.random() * 500);
  window.setTimeout(() => {
    room.messages.push({
      id: crypto.randomUUID(),
      role: "other",
      text: "확인했어! 곧 답할게.",
      ts: Date.now(),
    });
    if (store.appState.activeRoomId !== room.id) {
      room.unread += 1;
    }
    saveStore();
    renderChats();
    renderChatRoom();
  }, delay);
});

chatInput.addEventListener("input", updateCharCount);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

authTabButtons.forEach((button) => {
  button.addEventListener("click", () => handleAuthTab(button));
});

const boot = () => {
  initStore();
  seedDemoUser();
  renderFriends();
  renderChats();
  updateTabs();
  renderChatRoom();
  renderAvatarOptions();
  updateCharCount();
  if (store.session?.userId) {
    applyTheme();
    applyUserProfile();
    switchView(true);
  }
};

boot();
