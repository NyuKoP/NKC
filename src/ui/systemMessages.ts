type SystemMessageCandidate = {
  senderId: string;
  text: string;
  clientBatchId?: string;
  media?: unknown;
};

export const STARTED_CHAT_SYSTEM_TEXT = "채팅을 시작했어요.";

export const isSystemMessage = (
  message: SystemMessageCandidate,
  currentUserId?: string | null
) =>
  message.senderId === "system" ||
  (
    Boolean(currentUserId) &&
    message.senderId === currentUserId &&
    message.text === STARTED_CHAT_SYSTEM_TEXT &&
    !message.clientBatchId &&
    !message.media
  );
