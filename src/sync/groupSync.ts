import { commitAuthenticatedGroup, listConversations, listProfiles, saveConversation, saveMessage, type Conversation, type Message } from "../db/repo";
import type { ReceiveContext } from "../accounts/receiveContext";
import { getIdentityPublicKey } from "../security/identityKeys";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { parseAvatarRef } from "../utils/avatarRefs";
import type { Envelope } from "../crypto/box";
import { isSafePreviewMime } from "../security/mediaPolicy";
import { getAccountRootIdentity } from "../devices/deviceApprovals";
import { canonicalBytes } from "../crypto/canonicalJson";
import { getSodium } from "../security/sodium";

export type GroupCreatePayload = {
  id: string;
  name: string;
  memberIds: string[];
  actorId: string;
  ts: number;
  sharedAvatarRef?: string;
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

/** Existing Ed25519 peer identities, never profile row IDs. Group IDs are shared protocol IDs. */
export type GroupIdentityPayload = {
  type: "group"; v: 2; identityKind: "ed25519";
  kind: GroupEventPayload["kind"];
  groupId: string; actorIdentity: string; memberIdentities: string[];
  ts: number; name?: string; sharedAvatarRef?: string;
};

const validIdentity = (value: unknown): value is string => {
  try { return typeof value === "string" && decodeBase64Url(value).length === 32 &&
    encodeBase64Url(decodeBase64Url(value)) === value; } catch { return false; }
};

export const encodeGroupEvent = async (payload: GroupEventPayload, context: ReceiveContext): Promise<GroupIdentityPayload> => {
  await context.vault.assertMain();
  const profiles = await listProfiles(context.vault);
  const users = profiles.filter(profile => profile.kind === "user");
  const identity = await getAccountRootIdentity(context) ?? encodeBase64Url(await getIdentityPublicKey(context));

  if (users.length !== 1 || payload.actorId !== users[0].id) throw new Error("GROUP_ACTOR_MISMATCH");

  const memberIdentities = (payload.memberIds ?? [payload.actorId]).map(id => {
    if (id === users[0].id) return identity;

    const matches = profiles.filter(profile => profile.kind === "friend" && profile.id === id &&
      profile.friendStatus !== "blocked" && profile.friendStatus !== "deleted" && profile.trust?.status !== "blocked" &&
      profile.trust?.status !== "changed" && profile.verification?.status !== "key_changed" && validIdentity(profile.identityPub));

    if (matches.length !== 1) throw new Error("GROUP_MEMBER_UNMAPPED");

    return matches[0].identityPub!;
  });

  context.vault.assertLocal();

  return { type: "group", v: 2, identityKind: "ed25519", kind: payload.kind,
    groupId: payload.kind === "group.create" ? payload.id : payload.groupId,
    actorIdentity: identity, memberIdentities: [...new Set(memberIdentities)], ts: payload.ts,
    ...(payload.kind === "group.create" ? { name: payload.name, sharedAvatarRef: payload.sharedAvatarRef } : {}) };
};

/** The signature's pinned peer, rather than a claimed actor, supplies authority. No legacy alias map exists. */
export const mapIncomingGroupEvent = async (value: unknown, authenticatedIdentity: string,
  context: ReceiveContext): Promise<{ payload: GroupEventPayload; bindings: Array<{ id: string; identityPub: string }> } | null> => {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "group" ||
      !("kind" in value) || (value.kind !== "group.create" && value.kind !== "group.invite" && value.kind !== "group.leave")) return null;
  const payload = value;
  const kind = value.kind;
  const name = "name" in payload ? payload.name : undefined;
  const sharedAvatarRef = "sharedAvatarRef" in payload ? payload.sharedAvatarRef : undefined;

  if (!("v" in payload) || payload.v !== 2 || !("identityKind" in payload) || payload.identityKind !== "ed25519" ||
      !("actorIdentity" in payload) || payload.actorIdentity !== authenticatedIdentity ||
      !validIdentity(authenticatedIdentity) || !("groupId" in payload) || typeof payload.groupId !== "string" || !payload.groupId.trim() ||
      payload.groupId.length > 128 || !("ts" in payload) || typeof payload.ts !== "number" || !Number.isFinite(payload.ts) ||
      !("memberIdentities" in payload) || !Array.isArray(payload.memberIdentities) ||
      payload.memberIdentities.length > 256 || !payload.memberIdentities.every(validIdentity) ||
      (kind !== "group.leave" && !payload.memberIdentities.length) ||
      (kind === "group.create" && !payload.memberIdentities.includes(payload.actorIdentity)) ||
      (kind === "group.leave" && (payload.memberIdentities.length !== 1 || payload.memberIdentities[0] !== payload.actorIdentity)) ||
      (kind === "group.create" && (typeof name !== "string" || name.length > 256)) ||
      "actorId" in payload || "memberIds" in payload) return null;
  const profiles = await listProfiles(context.vault);
  const localIdentity = await getAccountRootIdentity(context) ?? encodeBase64Url(await getIdentityPublicKey(context));
  const users = profiles.filter(profile => profile.kind === "user");

  if (users.length !== 1) return null;

  const map = (identity: string) => {
    if (identity === localIdentity) return users[0].id;

    const matches = profiles.filter(profile => profile.kind === "friend" && profile.identityPub === identity &&
      profile.friendStatus !== "blocked" && profile.friendStatus !== "deleted" &&
      profile.trust?.status !== "blocked" && profile.trust?.status !== "changed" && profile.verification?.status !== "key_changed");

    return matches.length === 1 ? matches[0].id : null;
  };

  const identities = new Map([...new Set([payload.actorIdentity, ...payload.memberIdentities])]
    .map(identity => [identity, map(identity)]));

  const actorId = identities.get(payload.actorIdentity);
  const members = [...new Set(payload.memberIdentities)].map(identity => identities.get(identity));

  if (!actorId || [...identities.values()].some(id => !id)) return null;
  const avatar = sharedAvatarRef === undefined ? undefined : typeof sharedAvatarRef === "string" ? parseAvatarRef(sharedAvatarRef) : null;

  if (sharedAvatarRef !== undefined && (!avatar || avatar.ownerType !== "group" || avatar.ownerId !== payload.groupId ||
      !avatar.revision || !Number.isSafeInteger(avatar.size) || !avatar.size || avatar.size > 10 * 1024 * 1024 ||
      !isSafePreviewMime(avatar.mime) || !Number.isSafeInteger(avatar.chunkSize) || avatar.chunkSize <= 0 ||
      avatar.chunkSize > 1024 * 1024 || avatar.total !== Math.ceil(avatar.size / avatar.chunkSize))) return null;
  const base = { actorId, memberIds: members as string[], ts: payload.ts };
  context.vault.assertLocal();

  let mapped: GroupEventPayload;

  if (kind === "group.create") {
    if (typeof name !== "string") return null;
    mapped = { ...base, type: "group", kind, id: payload.groupId, name,
      sharedAvatarRef: typeof sharedAvatarRef === "string" ? sharedAvatarRef : undefined };
  } else {
    mapped = { ...base, type: "group", kind, groupId: payload.groupId };
  }

  return { payload: mapped, bindings: [...identities].map(([identityPub, id]) => ({ id: id!, identityPub })) };
};

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
    sharedAvatarRef?: string;
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
  sharedAvatarRef: next.sharedAvatarRef ?? existing?.sharedAvatarRef,
  sharedAvatarAuthorIdentityPub: existing?.sharedAvatarAuthorIdentityPub,
});

export const applyGroupEvent = async (
  payload: GroupEventPayload,
  senderId: string | null,
  currentUserId: string | null, context?: ReceiveContext,
  application?: { envelope: Envelope; eventHash: string; actorIdentity: string; bindings: Array<{ id: string; identityPub: string }> }
) => {
  if (!senderId || senderId !== payload.actorId || !Number.isFinite(payload.ts)) return false;

  const conversations = await listConversations(context?.vault);
  const groupId = payload.kind === "group.create" ? payload.id : payload.groupId;
  const existing = conversations.find((item) => item.id === groupId) || null;

  if (existing && existing.type !== "group") return false;
  const effectKey = context && application ? `group_effect_v2:${encodeBase64Url((await getSodium()).crypto_hash_sha256(canonicalBytes(payload)))}` : undefined;
  const messages: Message[] = [];

  const commit = async (next: Conversation) => {
    if (context) {
      if (!application) throw new Error("GROUP_APPLICATION_CONTEXT_REQUIRED");

      return commitAuthenticatedGroup(application.envelope, application.eventHash, next, messages,
        existing, context.vault, application.bindings, effectKey);
    }

    await saveConversation(next);

    for (const message of messages) await saveMessage(message);

    return true;
  };

  // The same signed mutation can arrive in a different endpoint/session envelope.
  if (existing && effectKey && await context!.vault.db.meta.get(effectKey)) return commit(existing);

  if (payload.kind === "group.create") {
    const memberIds = uniq([payload.actorId, ...payload.memberIds]);

    if (!canApplyForUser(memberIds, currentUserId)) return false;

    if (existing && (existing.participants.length !== memberIds.length || existing.participants.some(id => !memberIds.includes(id)))) return false;

    const next = buildBaseConversation(existing, {
      id: payload.id,
      name: payload.name,
      participants: memberIds,
      ts: payload.ts,
      lastMessage: "Group created",
      hidden: false,
      sharedAvatarRef: payload.sharedAvatarRef,
    });

    if (existing && !existing.participants.includes(senderId)) return false;

    if (application && payload.sharedAvatarRef) next.sharedAvatarAuthorIdentityPub = application.actorIdentity;

    return commit(next);
  }

  if (!existing) return false;

  if (!existing.participants.includes(senderId)) return false;

  if (payload.kind === "group.invite") {
    const memberIds = uniq([...existing.participants, ...payload.memberIds]);

    if (!canApplyForUser(memberIds, currentUserId)) return false;

    const next = buildBaseConversation(existing, {
      id: existing.id,
      name: existing.name,
      participants: memberIds,
      ts: payload.ts,
      lastMessage: "Members invited",
      hidden: false,
    });

    return commit(next);
  }

  const requestedTargets = payload.memberIds?.length ? payload.memberIds : [payload.actorId];

  const targets = requestedTargets.includes(payload.actorId)
    ? requestedTargets
    : [payload.actorId];

  const remaining = existing.participants.filter((id) => !targets.includes(id));
  const currentUserKey = currentUserId ?? "";
  const currentUserWasMember = existing.participants.includes(currentUserKey);
  const currentUserRemoved = targets.includes(currentUserKey);

  if (!currentUserWasMember && !currentUserRemoved) return false;
  const hidden = currentUserRemoved ? true : existing.hidden;
  const profiles = await listProfiles(context?.vault).catch(() => []);

  const resolveName = (id: string) => {
    if (id === currentUserId) return "나";

    const profile =
      profiles.find((item) => item.id === id || item.friendId === id) || null;

    return profile?.displayName || "알 수 없음";
  };

  const firstTarget = targets[0];

  const leaveLabel = firstTarget
    ? `${resolveName(firstTarget)}님이 나갔습니다.`
    : "멤버가 나갔습니다.";

  const next = buildBaseConversation(existing, {
    id: existing.id,
    name: existing.name,
    participants: remaining,
    ts: payload.ts,
    lastMessage: leaveLabel,
    hidden,
  });

  for (const targetId of targets) {
      const text =
        targetId === currentUserId
          ? "내가 나갔습니다."
          : `${resolveName(targetId)}님이 나갔습니다.`;

      const messageId = `system:group.leave:${existing.id}:${payload.ts}:${targetId}`;
      messages.push({
        id: messageId,
        convId: existing.id,
        senderId: "system",
        text,
        ts: payload.ts,
      });
  }

  return commit(next);
};
