export type MessageLike = {
  id: string;
  createdAt: number;
  senderId: string;
  clientBatchId?: string;
  kind: "text" | "media" | string;
};

export type MessageGroup<T extends MessageLike = MessageLike> = {
  key: string;
  senderId: string;
  createdAt: number;
  items: T[];
};

const kindOrder = (kind: MessageLike["kind"]) => {
  if (kind === "text") return 0;
  if (kind === "media") return 1;
  return 2;
};

export const groupMessages = <T extends MessageLike>(messages: T[]): MessageGroup<T>[] => {
  const groupsByKey = new Map<string, MessageGroup<T>>();

  messages.forEach((message) => {
    const groupKey = message.clientBatchId
      ? `b:${message.senderId}:${message.clientBatchId}`
      : `m:${message.id}`;
    const existing = groupsByKey.get(groupKey);
    if (existing) {
      existing.items.push(message);
      if (message.createdAt < existing.createdAt) {
        existing.createdAt = message.createdAt;
      }
      return;
    }
    groupsByKey.set(groupKey, {
      key: groupKey,
      senderId: message.senderId,
      createdAt: message.createdAt,
      items: [message],
    });
  });

  const groups = Array.from(groupsByKey.values());
  groups.forEach((group) => {
    group.items.sort((a, b) => {
      const kindDelta = kindOrder(a.kind) - kindOrder(b.kind);
      if (kindDelta !== 0) return kindDelta;
      const timeDelta = a.createdAt - b.createdAt;
      if (timeDelta !== 0) return timeDelta;
      return a.id.localeCompare(b.id);
    });
  });

  groups.sort((a, b) => {
    const timeDelta = a.createdAt - b.createdAt;
    if (timeDelta !== 0) return timeDelta;
    return a.key.localeCompare(b.key);
  });

  return groups;
};
