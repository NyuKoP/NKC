type KeyRecord = { identityPub: string; dhPub: string };

export const hasAuthenticatedFriendKeys = (profile?: {
  identityPub?: string; dhPub?: string; friendKeysAuthenticated?: KeyRecord;
}) => Boolean(profile?.identityPub && profile.dhPub &&
  profile.friendKeysAuthenticated?.identityPub === profile.identityPub &&
  profile.friendKeysAuthenticated.dhPub === profile.dhPub);

export const applyTOFU = (
  existing: KeyRecord | null | undefined,
  incoming: KeyRecord
): { ok: true; status: "trusted" } | { ok: false; status: "blocked"; reason: "key_changed" } => {
  if (!existing) return { ok: true, status: "trusted" };

  if (existing.identityPub === incoming.identityPub && existing.dhPub === incoming.dhPub) {
    return { ok: true, status: "trusted" };
  }

  return { ok: false, status: "blocked", reason: "key_changed" };
};

export const applyTofu = applyTOFU;
