import type { UserProfile } from "../db/repo";

type DisplayNameInput = {
  alias?: string | null;
  displayName?: string | null;
  friendId?: string | null;
  id?: string | null;
};

export const resolveDisplayName = (input: DisplayNameInput) => {
  const alias = typeof input.alias === "string" ? input.alias.trim() : "";

  if (alias) return alias;
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";

  if (displayName) return displayName;
  const friendId = typeof input.friendId === "string" ? input.friendId.trim() : "";

  if (friendId) return friendId;
  const id = typeof input.id === "string" ? input.id.trim() : "";

  if (id) return id.slice(0, 8);

  return "알 수 없음";
};

export const resolveFriendDisplayName = (
  friend: UserProfile | undefined,
  aliasesById?: Record<string, string | undefined>
) =>
  resolveDisplayName({
    alias: friend ? aliasesById?.[friend.id] : undefined,
    displayName: friend?.displayName,
    friendId: friend?.friendId,
    id: friend?.id,
  });
