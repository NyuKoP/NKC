import { db, ensureDbOpen } from "../db/schema";

export const setFriendAlias = async (friendId: string, alias: string | null) => {
  if (!friendId) return;
  await ensureDbOpen();
  const trimmed = alias?.trim() ?? "";
  if (!trimmed) {
    await db.friendAliases.delete(friendId);
    return;
  }
  await db.friendAliases.put({
    friendId,
    alias: trimmed,
    updatedAt: Date.now(),
  });
};

export const getFriendAlias = async (friendId: string) => {
  if (!friendId) return null;
  await ensureDbOpen();
  const record = await db.friendAliases.get(friendId);
  return record?.alias ?? null;
};

export const listFriendAliases = async () => {
  await ensureDbOpen();
  const records = await db.friendAliases.toArray();
  return Object.fromEntries(records.map((record) => [record.friendId, record.alias] as const));
};

