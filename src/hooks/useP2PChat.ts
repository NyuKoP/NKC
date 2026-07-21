import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listMessagesByConv,
  saveMessage,
  type MediaRef,
  type Message,
} from "../db/repo";
import { useP2PStore, type P2PConnectionSnapshot } from "../store/useP2PStore";
import { groupMessages, type MessageGroup, type MessageLike } from "../ui/groupMessages";
import { createId } from "../utils/ids";

export type ChatMessageStatus = "PENDING" | "SENT" | "FAILED";

export type ChatMessage = MessageLike & {
  convId: string;
  ts: number;
  text: string;
  status: ChatMessageStatus;
  media?: MediaRef;
};

export type P2PChatMessageEvent =
  | {
      type: "MESSAGE_RECEIVED" | "MESSAGE_ACK";
      message: ChatMessage;
    }
  | {
      type: "MESSAGE_FAILED";
      messageId: string;
      error?: string;
    };

export type P2PChatSendPayload = {
  conversationId: string;
  message: ChatMessage;
};

export type P2PChatAdapter = {
  loadMessages?: (conversationId: string) => Promise<Array<ChatMessage | Message>>;
  sendMessage?: (payload: P2PChatSendPayload) => Promise<ChatMessage | Message | void>;
  subscribeMessages?: (
    conversationId: string,
    handler: (event: P2PChatMessageEvent) => void
  ) => () => void;
};

export type UseP2PChatProps = {
  conversationId: string;
  currentUserId: string;
  adapter?: P2PChatAdapter;
};

export type UseP2PChatResult = {
  connection: P2PConnectionSnapshot | null;
  messages: ChatMessage[];
  groupedMessages: MessageGroup<ChatMessage>[];
  inputText: string;
  setInputText: (value: string) => void;
  sendMessage: () => Promise<void>;
  isSending: boolean;
  error: Error | null;
  reload: () => Promise<void>;
};

type BrowserP2PChatBridge = {
  getMessages?: (conversationId: string) => Promise<Array<ChatMessage | Message>>;
  sendMessage?: (payload: P2PChatSendPayload) => Promise<ChatMessage | Message | void>;
  onMessageEvent?: (
    conversationId: string,
    handler: (event: P2PChatMessageEvent) => void
  ) => () => void;
};

const isChatMessageStatus = (value: unknown): value is ChatMessageStatus =>
  value === "PENDING" || value === "SENT" || value === "FAILED";

const getBrowserP2PChatBridge = (): BrowserP2PChatBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = window as unknown as {
    p2p?: BrowserP2PChatBridge;
    electron?: { p2p?: BrowserP2PChatBridge };
  };
  return candidate.p2p ?? candidate.electron?.p2p ?? null;
};

export const toChatMessage = (
  message: ChatMessage | Message,
  fallbackStatus: ChatMessageStatus = "SENT"
): ChatMessage => {
  const candidate = message as Partial<ChatMessage> & Message;
  const createdAt =
    typeof candidate.createdAt === "number" ? candidate.createdAt : candidate.ts;
  const kind =
    typeof candidate.kind === "string"
      ? candidate.kind
      : candidate.media
        ? "media"
        : "text";
  const status = isChatMessageStatus(candidate.status) ? candidate.status : fallbackStatus;

  return {
    id: candidate.id,
    convId: candidate.convId,
    senderId: candidate.senderId,
    text: candidate.text,
    ts: candidate.ts,
    createdAt,
    clientBatchId: candidate.clientBatchId,
    kind,
    status,
    media: candidate.media,
  };
};

const toRepoMessage = (message: ChatMessage): Message => ({
  id: message.id,
  convId: message.convId,
  senderId: message.senderId,
  text: message.text,
  ts: message.ts,
  clientBatchId: message.clientBatchId,
  media: message.media,
});

const sortChatMessages = (messages: ChatMessage[]) =>
  [...messages].sort((left, right) => {
    const timeDelta = left.createdAt - right.createdAt;
    if (timeDelta !== 0) return timeDelta;
    return left.id.localeCompare(right.id);
  });

export const upsertChatMessage = (
  messages: ChatMessage[],
  incoming: ChatMessage
): ChatMessage[] => {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) return sortChatMessages([...messages, incoming]);
  const next = [...messages];
  next[index] = { ...next[index], ...incoming };
  return sortChatMessages(next);
};

export const applyP2PChatEvent = (
  messages: ChatMessage[],
  event: P2PChatMessageEvent
): ChatMessage[] => {
  if (event.type === "MESSAGE_FAILED") {
    return messages.map((message) =>
      message.id === event.messageId ? { ...message, status: "FAILED" } : message
    );
  }
  const status = event.type === "MESSAGE_ACK" ? "SENT" : event.message.status;
  return upsertChatMessage(messages, { ...event.message, status });
};

const defaultLoadMessages = async (conversationId: string) => {
  const bridge = getBrowserP2PChatBridge();
  if (bridge?.getMessages) {
    return (await bridge.getMessages(conversationId)).map((message) => toChatMessage(message));
  }
  return (await listMessagesByConv(conversationId)).map((message) => toChatMessage(message));
};

const defaultSendMessage = async ({ conversationId, message }: P2PChatSendPayload) => {
  const bridge = getBrowserP2PChatBridge();
  if (bridge?.sendMessage) {
    const acknowledged = await bridge.sendMessage({ conversationId, message });
    return acknowledged ? toChatMessage(acknowledged) : undefined;
  }
  await saveMessage(toRepoMessage(message));
  return undefined;
};

const defaultSubscribeMessages = (
  conversationId: string,
  handler: (event: P2PChatMessageEvent) => void
) => {
  const bridge = getBrowserP2PChatBridge();
  if (!bridge?.onMessageEvent) return () => {};
  return bridge.onMessageEvent(conversationId, handler);
};

export const useP2PChat = ({
  conversationId,
  currentUserId,
  adapter,
}: UseP2PChatProps): UseP2PChatResult => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const connection = useP2PStore(
    useCallback(
      (state) => state.connectionsByConvId[conversationId] ?? null,
      [conversationId]
    )
  );

  const loadMessages = adapter?.loadMessages ?? defaultLoadMessages;
  const sendMessageAdapter = adapter?.sendMessage ?? defaultSendMessage;
  const subscribeMessages = adapter?.subscribeMessages ?? defaultSubscribeMessages;

  const reload = useCallback(async () => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    try {
      const history = await loadMessages(conversationId);
      setMessages(sortChatMessages(history.map((message) => toChatMessage(message))));
      setError(null);
    } catch (caught) {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      console.error("Failed to load P2P chat messages", nextError);
    }
  }, [conversationId, loadMessages]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!conversationId) {
        if (active) setMessages([]);
        return;
      }
      try {
        const history = await loadMessages(conversationId);
        if (active) {
          setMessages(sortChatMessages(history.map((message) => toChatMessage(message))));
          setError(null);
        }
      } catch (caught) {
        const nextError = caught instanceof Error ? caught : new Error(String(caught));
        if (active) {
          setError(nextError);
          console.error("Failed to load P2P chat messages", nextError);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [conversationId, loadMessages]);

  useEffect(() => {
    if (!conversationId) return () => {};
    return subscribeMessages(conversationId, (event) => {
      setMessages((current) => applyP2PChatEvent(current, event));
    });
  }, [conversationId, subscribeMessages]);

  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isSending || !conversationId) return;

    const now = Date.now();
    const optimisticMessage: ChatMessage = {
      id: createId(),
      convId: conversationId,
      createdAt: now,
      ts: now,
      senderId: currentUserId,
      clientBatchId: createId(),
      kind: "text",
      text,
      status: "PENDING",
    };

    setMessages((current) => upsertChatMessage(current, optimisticMessage));
    setInputText("");
    setIsSending(true);
    setError(null);

    try {
      const acknowledged = await sendMessageAdapter({
        conversationId,
        message: optimisticMessage,
      });
      if (acknowledged) {
        setMessages((current) => upsertChatMessage(current, toChatMessage(acknowledged, "SENT")));
      }
    } catch (caught) {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticMessage.id ? { ...message, status: "FAILED" } : message
        )
      );
      console.error("Failed to send P2P chat message", nextError);
    } finally {
      setIsSending(false);
    }
  }, [conversationId, currentUserId, inputText, isSending, sendMessageAdapter]);

  return {
    connection,
    messages,
    groupedMessages,
    inputText,
    setInputText,
    sendMessage,
    isSending,
    error,
    reload,
  };
};
