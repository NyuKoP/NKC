import { useEffect, useRef } from "react";
import {
  useP2PChat,
  type ChatMessage,
  type P2PChatAdapter,
} from "../hooks/useP2PChat";
import "../styles/app.css";

type MainChatProps = {
  conversationId: string;
  peerName: string;
  currentUserId: string;
  adapter?: P2PChatAdapter;
};

const formatMessageTime = (timestamp: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

const statusDotClass = (state?: string) => {
  if (state === "connected") return "status-dot online";
  if (state === "connecting" || state === "reconnecting") return "status-dot away";
  return "status-dot offline";
};

const connectionLabel = (state?: string) => {
  if (state === "connected") return "P2P 채널 연결됨";
  if (state === "connecting") return "P2P 채널 연결 중";
  if (state === "reconnecting") return "P2P 채널 복구 중";
  if (state === "closed") return "P2P 채널 종료됨";
  return "P2P 채널 대기 중";
};

const messageStatusLabel = (message: ChatMessage) => {
  if (message.status === "SENT") return "전송됨";
  if (message.status === "FAILED") return "실패";
  return "전송 대기";
};

export const MainChat = ({
  conversationId,
  peerName,
  currentUserId,
  adapter,
}: MainChatProps) => {
  const {
    connection,
    groupedMessages,
    inputText,
    setInputText,
    sendMessage,
    isSending,
  } = useP2PChat({ conversationId, currentUserId, adapter });
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const connectionState = connection?.state;
  const isOnline = connectionState === "connected";
  const peerInitial = (peerName.trim()[0] ?? "?").toUpperCase();

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTop = timeline.scrollHeight;
  }, [groupedMessages]);

  return (
    <div className="main-chat">
      <header className="main-header">
        <div className="header-left">
          <div className="avatar large">
            {peerInitial}
            {isOnline ? <span className="qr-badge">P2P</span> : null}
          </div>
          <div>
            <div className="header-title">{peerName}</div>
            <div className="header-sub">
              <span className={statusDotClass(connectionState)} /> {connectionLabel(connectionState)}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-button ghost" aria-label="대화 옵션">
            ...
          </button>
        </div>
      </header>

      <div className="timeline" ref={timelineRef}>
        <div className="timeline-inner">
          {groupedMessages.length === 0 ? (
            <div className="empty-state">
              <p>암호화된 P2P 채널이 준비되었습니다.</p>
              <p className="muted">메시지는 로컬 저장소와 동기화 엔진을 통해 반영됩니다.</p>
            </div>
          ) : (
            groupedMessages.map((group) => {
              const isMine = group.senderId === currentUserId;
              return (
                <div key={group.key} className={`message-row ${isMine ? "out" : "in"}`}>
                  <div className="message-bubble">
                    {group.items.map((message) => (
                      <div key={message.id} className="message-content">
                        <div className="message-body">{message.text}</div>
                        <div className="message-meta">
                          {formatMessageTime(message.createdAt)}
                          {isMine ? ` · ${messageStatusLabel(message)}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void sendMessage();
            }}
            placeholder={
              isOnline
                ? "안전한 P2P 메시지 입력..."
                : "상대가 오프라인입니다. 연결 후 전송 상태가 갱신됩니다."
            }
            disabled={isSending}
            rows={1}
          />
          <button
            type="button"
            className="send-button"
            onClick={() => {
              void sendMessage();
            }}
            disabled={!inputText.trim() || isSending}
          >
            {isSending ? "전송 중" : "보내기"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MainChat;
