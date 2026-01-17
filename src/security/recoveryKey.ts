import { getSecureStore } from "./secureStore";

const RECOVERY_CONFIRM_KEY = "nkc_recovery_confirmed_v1";
const RECOVERY_KEY_STORE = "nkc_recovery_key_v1";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const generateRecoveryKey = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
};

export const maskKey = (value: string, masked: boolean) => {
  if (!masked) return value;
  if (!value) return "";
  return "•".repeat(value.length);
};

export const copyRecoveryKey = async (value: string) => {
  if (!value) return;
  await navigator.clipboard.writeText(value);
};

export const saveRecoveryKey = async (value: string) => {
  const store = getSecureStore();
  await store.set(
    RECOVERY_KEY_STORE,
    JSON.stringify({ key: value, updatedAt: Date.now() })
  );
};

export const getSavedRecoveryKey = async () => {
  const store = getSecureStore();
  const raw = await store.get(RECOVERY_KEY_STORE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { key: string };
    return parsed.key || null;
  } catch (error) {
    console.error("Failed to read recovery key", error);
    await store.remove(RECOVERY_KEY_STORE);
    return null;
  }
};

export const clearSavedRecoveryKey = async () => {
  const store = getSecureStore();
  await store.remove(RECOVERY_KEY_STORE);
};

export const getRecoveryConfirmed = async () => {
  const store = getSecureStore();
  const raw = await store.get(RECOVERY_CONFIRM_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { confirmed: boolean };
    return Boolean(parsed.confirmed);
  } catch (error) {
    console.error("Failed to read recovery confirmation", error);
    await store.remove(RECOVERY_CONFIRM_KEY);
    return false;
  }
};

export const setRecoveryConfirmed = async (confirmed: boolean) => {
  const store = getSecureStore();
  await store.set(
    RECOVERY_CONFIRM_KEY,
    JSON.stringify({ confirmed, updatedAt: Date.now() })
  );
};

export const clearRecoveryConfirmed = async () => {
  const store = getSecureStore();
  await store.remove(RECOVERY_CONFIRM_KEY);
};
