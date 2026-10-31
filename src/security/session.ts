import { getActiveAccountId } from "../accounts/accountRegistry";
import { getAccountOwnerGeneration, onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { getSecretStore } from "./secretStore";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

const SESSION_KEY = "nkc_session_v1";

const MAX_TTL_MS = Number.MAX_SAFE_INTEGER;

const DEFAULT_TTL_MS = MAX_TTL_MS;

let memorySession: { vaultKey: Uint8Array; expiresAt: number; createdAt: number; accountId: string; generation: number } | null = null;

const clearMemorySession = () => {
  memorySession?.vaultKey.fill(0);
  memorySession = null;
};

onAccountOwnerChange(clearMemorySession);

const captureOwner = () => {
  const accountId = getActiveAccountId();
  const generation = getAccountOwnerGeneration();

  return { accountId, generation, assertLocal: () => {
    if (accountId !== getActiveAccountId() || generation !== getAccountOwnerGeneration()) throw new Error("OWNER_SESSION_CHANGED");
  } };
};

type PersistedSession = {
  v: 1;
  vaultKey_b64: string;
  expiresAt: number;
  createdAt: number;
};

const clampTtl = (ttlMs: number) => Math.min(ttlMs, MAX_TTL_MS);

export const setSession = async (vaultKey: Uint8Array, ttlMs = DEFAULT_TTL_MS) => {
  const owner = captureOwner();
  const store = getSecretStore();
  const nextKey = new Uint8Array(vaultKey);
  const now = Date.now();
  const expiresAt = Math.min(now + clampTtl(ttlMs), MAX_TTL_MS);
  const persisted: PersistedSession = {
    v: 1,
    vaultKey_b64: encodeBase64Url(nextKey),
    createdAt: now,
    expiresAt,
  };

  try {
    await store.set(SESSION_KEY, JSON.stringify(persisted));
    owner.assertLocal();
    clearMemorySession();
    memorySession = { vaultKey: nextKey, createdAt: now, expiresAt,
      accountId: owner.accountId, generation: owner.generation };
  } catch (error) { nextKey.fill(0); throw error; }
};

export const getSession = async () => {
  const owner = captureOwner();

  if (memorySession && (memorySession.accountId !== owner.accountId || memorySession.generation !== owner.generation)) clearMemorySession();

  if (memorySession) {
    if (memorySession.expiresAt <= Date.now()) {
      await clearSession();

      return null;
    }

    return { vaultKey: memorySession.vaultKey, expiresAt: memorySession.expiresAt };
  }

  let store: ReturnType<typeof getSecretStore> | undefined;

  try {
    store = getSecretStore();
    const raw = await store.get(SESSION_KEY);
    owner.assertLocal();

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
      accountId: owner.accountId,
      generation: owner.generation,
      createdAt: persisted.createdAt,
      expiresAt: persisted.expiresAt,
    };

    return { vaultKey, expiresAt: persisted.expiresAt };
  } catch {
    try {
      owner.assertLocal();
      await store?.remove(SESSION_KEY);
    } catch {
      // The encrypted store is unavailable; remain logged out.
    }

    return null;
  }
};

export const clearSession = async () => {
  clearMemorySession();

  try {
    const store = getSecretStore();
    await store.remove(SESSION_KEY);
  } catch {
    return;
  }
};
