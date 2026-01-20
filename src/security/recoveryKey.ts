import { getPublicStore } from "./publicStore";

const RECOVERY_CONFIRM_KEY = "nkc_recovery_confirmed_v1";
const LEGACY_RECOVERY_KEY = "recovery_key_v1";
const LEGACY_RECOVERY_IDS = "recovery_key_ids_v1";

const toBase64Url = (bytes: Uint8Array) => {
  const b64 = btoa(String.fromCharCode(...Array.from(bytes)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const generateAccountKeyNKC = async (): Promise<string> => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `NKC-${toBase64Url(bytes)}`;
};

export const getRecoveryKeyConfirmed = async () => {
  const store = getPublicStore();
  const raw = await store.get(RECOVERY_CONFIRM_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { confirmed: boolean };
    return Boolean(parsed.confirmed);
  } catch {
    await store.remove(RECOVERY_CONFIRM_KEY);
    return false;
  }
};

export const setRecoveryKeyConfirmed = async (confirmed: boolean) => {
  const store = getPublicStore();
  await store.set(
    RECOVERY_CONFIRM_KEY,
    JSON.stringify({ confirmed, updatedAt: Date.now() })
  );
};

export const cleanupLegacyRecoveryKey = async () => {
  const store = getPublicStore();
  await store.remove(LEGACY_RECOVERY_KEY);
  await store.remove(LEGACY_RECOVERY_IDS);
};

export const maskKey = (value: string, masked: boolean) => {
  if (!masked) return value;
  if (!value) return "";
  return "*".repeat(value.length);
};

export const copyRecoveryKey = async (value: string) => {
  if (!value) return;
  await navigator.clipboard.writeText(value);
};
