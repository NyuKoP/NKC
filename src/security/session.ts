import { getSecretStore } from "./secretStore";

const SESSION_KEY = "nkc_session_v1";
const MAX_TTL_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_TTL_MS = MAX_TTL_MS;

let memorySession: { vaultKey: Uint8Array; expiresAt: number; createdAt: number } | null = null;

const clampTtl = (ttlMs: number) => Math.min(ttlMs, MAX_TTL_MS);

const removeLegacyPersistedSession = async () => {
  try {
    const store = getSecretStore();
    await store.remove(SESSION_KEY);
  } catch {
    return;
  }
};

export const setSession = async (vaultKey: Uint8Array, ttlMs = DEFAULT_TTL_MS) => {
  const now = Date.now();
  const expiresAt = Math.min(now + clampTtl(ttlMs), MAX_TTL_MS);
  memorySession = {
    vaultKey: new Uint8Array(vaultKey),
    createdAt: now,
    expiresAt,
  };

};

export const getSession = async () => {
  if (memorySession) {
    if (memorySession.expiresAt <= Date.now()) {
      memorySession = null;
      await clearSession();
      return null;
    }
    return { vaultKey: memorySession.vaultKey, expiresAt: memorySession.expiresAt };
  }

  await removeLegacyPersistedSession();
  return null;
};

export const clearSession = async () => {
  memorySession = null;
  try {
    const store = getSecretStore();
    await store.remove(SESSION_KEY);
  } catch {
    return;
  }
};
