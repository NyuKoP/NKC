import { getSecretStore } from "./secretStore";

type SessionRecord = {
  v: 1;
  scope: "vault";
  createdAt: number;
  expiresAt: number;
  key_b64: string;
};

type SessionOptions = {
  remember?: boolean;
};

const SESSION_KEY = "nkc_session_v1";
const MAX_TTL_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_TTL_MS = MAX_TTL_MS;

const toB64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

const fromB64 = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

let memorySession: { vaultKey: Uint8Array; expiresAt: number; createdAt: number } | null = null;

const clampTtl = (ttlMs: number) => Math.min(ttlMs, MAX_TTL_MS);

const loadPersistedSession = async () => {
  try {
    const store = getSecretStore();
    const raw = await store.get(SESSION_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as SessionRecord;
    if (record.v !== 1 || record.scope !== "vault") {
      await store.remove(SESSION_KEY);
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      await store.remove(SESSION_KEY);
      return null;
    }
    if (!record.key_b64) {
      await store.remove(SESSION_KEY);
      return null;
    }
    return {
      vaultKey: fromB64(record.key_b64),
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  } catch {
    return null;
  }
};

export const setSession = async (
  vaultKey: Uint8Array,
  ttlMs = DEFAULT_TTL_MS,
  options: SessionOptions = {}
) => {
  const now = Date.now();
  clampTtl(ttlMs);
  const expiresAt = Number.MAX_SAFE_INTEGER;
  memorySession = {
    vaultKey: new Uint8Array(vaultKey),
    createdAt: now,
    expiresAt,
  };

  if (!options.remember) return;
  try {
    const store = getSecretStore();
    const record: SessionRecord = {
      v: 1,
      scope: "vault",
      createdAt: now,
      expiresAt,
      key_b64: toB64(vaultKey),
    };
    await store.set(SESSION_KEY, JSON.stringify(record));
  } catch {
    return;
  }
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

  const persisted = await loadPersistedSession();
  if (!persisted) return null;
  memorySession = {
    vaultKey: persisted.vaultKey,
    createdAt: persisted.createdAt,
    expiresAt: persisted.expiresAt,
  };
  return { vaultKey: persisted.vaultKey, expiresAt: persisted.expiresAt };
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
