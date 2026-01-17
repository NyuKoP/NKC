import { getSecureStore } from "./secureStore";

type SessionRecord = {
  v: 1;
  scope: "vault";
  createdAt: number;
  expiresAt: number;
  mask_b64: string;
  key_b64: string;
  keyId_b64?: string;
};

const SESSION_KEY = "nkc_session_v1";
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const toB64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

const fromB64 = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const xorBytes = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] ^ b[i];
  }
  return out;
};

const randomBytes = (length: number) => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const computeKeyId = async (vaultKey: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", vaultKey);
  const short = new Uint8Array(digest).slice(0, 16);
  return toB64(short);
};

export const setSession = async (vaultKey: Uint8Array, ttlMs = DEFAULT_TTL_MS) => {
  const store = getSecureStore();
  const mask = randomBytes(vaultKey.length);
  const masked = xorBytes(vaultKey, mask);
  const keyId = await computeKeyId(vaultKey);
  const record: SessionRecord = {
    v: 1,
    scope: "vault",
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    mask_b64: toB64(mask),
    key_b64: toB64(masked),
    keyId_b64: keyId ?? undefined,
  };
  await store.set(SESSION_KEY, JSON.stringify(record));
};

export const getSession = async () => {
  const store = getSecureStore();
  const raw = await store.get(SESSION_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SessionRecord;
    if (record.v !== 1 || record.scope !== "vault") {
      await store.remove(SESSION_KEY);
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      await store.remove(SESSION_KEY);
      return null;
    }
    const mask = fromB64(record.mask_b64);
    const masked = fromB64(record.key_b64);
    if (mask.length !== masked.length) {
      await store.remove(SESSION_KEY);
      return null;
    }
    return {
      vaultKey: xorBytes(masked, mask),
      expiresAt: record.expiresAt,
      keyId: record.keyId_b64 ?? null,
    };
  } catch (error) {
    console.error("Failed to read session", error);
    await store.remove(SESSION_KEY);
    return null;
  }
};

export const clearSession = async () => {
  const store = getSecureStore();
  await store.remove(SESSION_KEY);
};
