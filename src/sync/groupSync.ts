import { listConversations, saveConversation, type Conversation } from "../db/repo";

export type GroupCreatePayload = {
  id: string;
  name: string;
  memberIds: string[];
  actorId: string;
  ts: number;
};

export type GroupInvitePayload = {
  groupId: string;
  memberIds: string[];
  actorId: string;
  ts: number;
};

export type GroupLeavePayload = {
  groupId: string;
  memberIds?: string[];
  actorId: string;
  ts: number;
};

export type GroupEventPayload =
  | ({ type: "group"; kind: "group.create" } & GroupCreatePayload)
  | ({ type: "group"; kind: "group.invite" } & GroupInvitePayload)
  | ({ type: "group"; kind: "group.leave" } & GroupLeavePayload);

export const syncGroupCreate = async (payload: GroupCreatePayload) => ({
  type: "group" as const,
  kind: "group.create" as const,
  ...payload,
});

export const buildGroupInviteEvent = (payload: GroupInvitePayload): GroupEventPayload => ({
  type: "group",
  kind: "group.invite",
  ...payload,
});

export const buildGroupLeaveEvent = (payload: GroupLeavePayload): GroupEventPayload => ({
  type: "group",
  kind: "group.leave",
  ...payload,
});

export const isGroupEventPayload = (value: unknown): value is GroupEventPayload => {
  if (!value || typeof value !== "object") return false;
  const typed = value as { type?: string; kind?: string };
  if (typed.type !== "group") return false;
  return (
    typed.kind === "group.create" ||
    typed.kind === "group.invite" ||
    typed.kind === "group.leave"
  );
};

const uniq = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const canApplyForUser = (memberIds: string[], currentUserId: string | null) =>
  Boolean(currentUserId && memberIds.includes(currentUserId));

const buildBaseConversation = (
  existing: Conversation | null,
  next: {
    id: string;
    name: string;
    participants: string[];
    ts: number;
    lastMessage: string;
    hidden: boolean;
  }
): Conversation => ({
  id: next.id,
  type: "group",
  name: next.name || existing?.name || "Group",
  pinned: existing?.pinned ?? false,
  unread: existing?.unread ?? 0,
  hidden: next.hidden,
  muted: existing?.muted ?? false,
  blocked: existing?.blocked ?? false,
  pendingAcceptance: existing?.pendingAcceptance,
  lastTs: Math.max(existing?.lastTs ?? 0, next.ts),
  lastMessage: next.lastMessage || existing?.lastMessage || "",
  participants: next.participants,
});

export const applyGroupEvent = async (
  payload: GroupEventPayload,
  senderId: string | null,
  currentUserId: string | null
) => {
  if (!senderId || senderId !== payload.actorId) return;

  const conversations = await listConversations();
  const groupId = payload.kind === "group.create" ? payload.id : payload.groupId;
  const existing = conversations.find((item) => item.id === groupId) || null;

  if (payload.kind === "group.create") {
    const memberIds = uniq([payload.actorId, ...payload.memberIds]);
    if (!canApplyForUser(memberIds, currentUserId)) return;
    const next = buildBaseConversation(existing, {
      id: payload.id,
      name: payload.name,
      participants: memberIds,
      ts: payload.ts,
      lastMessage: "Group created",
      hidden: false,
    });
    await saveConversation(next);
    return;
  }

  if (!existing) return;
  if (!existing.participants.includes(senderId)) return;

  if (payload.kind === "group.invite") {
    const memberIds = uniq([...existing.participants, ...payload.memberIds]);
    if (!canApplyForUser(memberIds, currentUserId)) return;
    const next = buildBaseConversation(existing, {
      id: existing.id,
      name: existing.name,
      participants: memberIds,
      ts: payload.ts,
      lastMessage: "Members invited",
      hidden: false,
    });
    await saveConversation(next);
    return;
  }

  const requestedTargets = payload.memberIds?.length ? payload.memberIds : [payload.actorId];
  const targets = requestedTargets.includes(payload.actorId)
    ? requestedTargets
    : [payload.actorId];
  const remaining = existing.participants.filter((id) => !targets.includes(id));
  const currentUserKey = currentUserId ?? "";
  const currentUserWasMember = existing.participants.includes(currentUserKey);
  const currentUserRemoved = targets.includes(currentUserKey);
  if (!currentUserWasMember && !currentUserRemoved) return;
  const hidden = currentUserRemoved ? true : existing.hidden;
  const next = buildBaseConversation(existing, {
    id: existing.id,
    name: existing.name,
    participants: remaining,
    ts: payload.ts,
    lastMessage: "Member left",
    hidden,
  });
  await saveConversation(next);
};
