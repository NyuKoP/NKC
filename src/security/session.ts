import { getSecretStore } from "./secretStore";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

const SESSION_KEY = "nkc_session_v1";
const MAX_TTL_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_TTL_MS = MAX_TTL_MS;

let memorySession: { vaultKey: Uint8Array; expiresAt: number; createdAt: number } | null = null;

type PersistedSession = {
  v: 1;
  vaultKey_b64: string;
  expiresAt: number;
  createdAt: number;
};

const clampTtl = (ttlMs: number) => Math.min(ttlMs, MAX_TTL_MS);

export const setSession = async (vaultKey: Uint8Array, ttlMs = DEFAULT_TTL_MS) => {
  const now = Date.now();
  const expiresAt = Math.min(now + clampTtl(ttlMs), MAX_TTL_MS);
  memorySession = {
    vaultKey: new Uint8Array(vaultKey),
    createdAt: now,
    expiresAt,
  };
  const persisted: PersistedSession = {
    v: 1,
    vaultKey_b64: encodeBase64Url(vaultKey),
    createdAt: now,
    expiresAt,
  };
  await getSecretStore().set(SESSION_KEY, JSON.stringify(persisted));
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

  try {
    const store = getSecretStore();
    const raw = await store.get(SESSION_KEY);
    if (!raw) return null;
    const persisted = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      persisted.v !== 1 ||
      typeof persisted.vaultKey_b64 !== "string" ||
      typeof persisted.createdAt !== "number" ||
      typeof persisted.expiresAt !== "number" ||
      persisted.expiresAt <= Date.now()
    ) {
      await store.remove(SESSION_KEY);
      return null;
    }
    const vaultKey = decodeBase64Url(persisted.vaultKey_b64);
    memorySession = {
      vaultKey,
      createdAt: persisted.createdAt,
      expiresAt: persisted.expiresAt,
    };
    return { vaultKey, expiresAt: persisted.expiresAt };
  } catch {
    try {
      await getSecretStore().remove(SESSION_KEY);
    } catch {
      // The encrypted store is unavailable; remain logged out.
    }
    return null;
  }
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
