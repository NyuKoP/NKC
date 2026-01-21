type KeyRecord = { identityPub: string; dhPub: string };

export const applyTOFU = (
  existing: KeyRecord | null | undefined,
  incoming: KeyRecord
): { ok: boolean; status: "trusted" | "blocked"; reason?: string } => {
  if (!existing) return { ok: true, status: "trusted" };
  if (existing.identityPub === incoming.identityPub && existing.dhPub === incoming.dhPub) {
    return { ok: true, status: "trusted" };
  }
  return { ok: false, status: "blocked", reason: "key_changed" };
};

export const applyTofu = applyTOFU;

