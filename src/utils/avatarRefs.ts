import type { AvatarRef, Conversation } from "../db/repo";

export const serializeAvatarRef = (ref: AvatarRef): string => JSON.stringify(ref);

export const parseAvatarRef = (ref?: string | AvatarRef | null): AvatarRef | undefined => {
  if (!ref) return undefined;
  if (typeof ref !== "string") return ref;
  try {
    const parsed = JSON.parse(ref) as Partial<AvatarRef>;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (!parsed.ownerId || !parsed.mime) return undefined;
    if (!Number.isFinite(parsed.total) || !Number.isFinite(parsed.chunkSize)) return undefined;
    const ownerType = parsed.ownerType === "group" ? "group" : "profile";
    return {
      ownerType,
      ownerId: parsed.ownerId,
      mime: parsed.mime,
      total: Number(parsed.total),
      chunkSize: Number(parsed.chunkSize),
    };
  } catch {
    return undefined;
  }
};

export const resolveGroupAvatarRef = (
  conversation: Conversation | null,
  overrideRef?: string | null
) => {
  if (!conversation) return undefined;
  const isGroup = conversation.type === "group" || conversation.participants.length > 2;
  if (!isGroup) return undefined;
  const override = parseAvatarRef(overrideRef);
  if (override) return override;
  return parseAvatarRef(conversation.sharedAvatarRef);
};

