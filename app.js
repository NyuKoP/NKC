const chat = document.getElementById("chat");
const composer = document.getElementById("composer");
const messageInput = document.getElementById("message");
const clearBtn = document.getElementById("clear-btn");
const charCount = document.getElementById("char-count");
const sessionIdLabel = document.getElementById("session-id");
const conversationTitle = document.getElementById("conversation-title");
const contactButtons = document.querySelectorAll("[data-contact]");

const MAX_LENGTH = 240;

const contacts = [
  { id: "alpha", name: "알파 팀", prompt: "새로운 아이디어 공유" },
  { id: "bravo", name: "브라보", prompt: "오늘 회의 정리" },
  { id: "charlie", name: "찰리", prompt: "프로젝트 일정 체크" },
];

const defaultMessages = (contactName) => [
  {
    id: crypto.randomUUID(),
    text: `${contactName}와(과) 대화를 시작합니다.`,
    sender: "system",
  },
];

const state = {
  activeContactId: contacts[0].id,
  conversations: Object.fromEntries(
    contacts.map((contact) => [contact.id, defaultMessages(contact.name)]),
  ),
};

const generateSessionId = () =>
  `anon-${crypto.randomUUID().split("-")[0]}`;

const renderMessages = () => {
  chat.innerHTML = "";

  const messages = state.conversations[state.activeContactId] ?? [];

  messages.forEach((message) => {
    const wrapper = document.createElement("article");
    wrapper.className = "chat__message";

    if (message.sender === "me") {
      wrapper.classList.add("chat__message--me");
    }

    const bubble = document.createElement("div");
    bubble.className = "chat__bubble";
    bubble.textContent = message.text;

    const meta = document.createElement("div");
    meta.className = "chat__meta";
    meta.textContent = `${message.sender === "me" ? "나" : "시스템"}`;

    wrapper.append(bubble, meta);
    chat.appendChild(wrapper);
  });

  chat.scrollTop = chat.scrollHeight;
};

const addMessage = (text, sender) => {
  state.conversations[state.activeContactId].push({
    id: crypto.randomUUID(),
    text,
    sender,
  });
  renderMessages();
};

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim().slice(0, MAX_LENGTH);
  if (!text) {
    messageInput.focus();
    return;
  }
  addMessage(text, "me");
  messageInput.value = "";
  messageInput.focus();
  updateCharCount();

  window.setTimeout(() => {
    addMessage("좋아요! 다음 메시지를 기다리고 있어요.", "system");
  }, 600);
});

clearBtn.addEventListener("click", () => {
  const contact = contacts.find((item) => item.id === state.activeContactId);
  state.conversations[state.activeContactId] = [
    {
      id: crypto.randomUUID(),
      text: `${contact?.name ?? "상대"}와(과) 새 대화를 시작합니다.`,
      sender: "system",
    },
  ];
  renderMessages();
});

const updateCharCount = () => {
  const length = messageInput.value.length;
  charCount.textContent = `${length} / ${MAX_LENGTH}`;
};

messageInput.addEventListener("input", updateCharCount);

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

const setActiveContact = (contactId) => {
  const contact = contacts.find((item) => item.id === contactId);
  if (!contact) return;
  state.activeContactId = contactId;
  conversationTitle.textContent = contact.name;
  contactButtons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.contact === contactId,
    );
  });
  renderMessages();
};

contactButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveContact(button.dataset.contact);
  });
});

renderMessages();
updateCharCount();
sessionIdLabel.textContent = generateSessionId();
setActiveContact(state.activeContactId);
