import { getPublicStore } from "./publicStore";
import { getSecretStore } from "./secretStore";
import type { MainAccountSession } from "../accounts/mainSessionTypes";
import type { VaultAccess } from "../db/vaultAccess";

const START_KEY_CONFIRM_KEY = "nkc_start_key_confirmed_v1";

const LEGACY_CONFIRM_KEY = "nkc_recovery_confirmed_v1";

const LEGACY_RECOVERY_KEY = "recovery_key_v1";

const LEGACY_RECOVERY_IDS = "recovery_key_ids_v1";

const STORED_START_KEY = "nkc_start_key_v1";

const toBase64Url = (bytes: Uint8Array) => {
  const b64 = btoa(String.fromCharCode(...Array.from(bytes)));

  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const generateStartKey = async (): Promise<string> => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }

  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);

  return `NKC-${toBase64Url(bytes)}`;
};

const parseConfirm = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as { confirmed: boolean };

    return Boolean(parsed.confirmed);
  } catch {
    return null;
  }
};

export const getStartKeyConfirmed = async () => {
  const store = getPublicStore();
  const raw = await store.get(START_KEY_CONFIRM_KEY);

  if (raw) {
    const confirmed = parseConfirm(raw);

    if (confirmed === null) {
      await store.remove(START_KEY_CONFIRM_KEY);

      return false;
    }

    return confirmed;
  }

  const legacyRaw = await store.get(LEGACY_CONFIRM_KEY);

  if (!legacyRaw) return false;
  const confirmed = parseConfirm(legacyRaw);

  if (confirmed === null) {
    await store.remove(LEGACY_CONFIRM_KEY);

    return false;
  }

  await store.set(
    START_KEY_CONFIRM_KEY,
    JSON.stringify({ confirmed, updatedAt: Date.now() })
  );
  await store.remove(LEGACY_CONFIRM_KEY);

  return confirmed;
};

export const setStartKeyConfirmed = async (confirmed: boolean, owner?: VaultAccess) => {
  const store = getPublicStore(owner);
  await store.set(
    START_KEY_CONFIRM_KEY,
    JSON.stringify({ confirmed, updatedAt: Date.now() })
  );
};

export const getStoredStartKey = async () => {
  try {
    return await getSecretStore().get(STORED_START_KEY);
  } catch {
    return null;
  }
};

export const storeStartKey = async (value: string, session?: MainAccountSession) => {
  try {
    await getSecretStore(session).set(STORED_START_KEY, value);

    return true;
  } catch {
    return false;
  }
};

export const removeStoredStartKey = async () => {
  try {
    await getSecretStore().remove(STORED_START_KEY);
  } catch {
    // The secure store is optional in browser-only development builds.
  }
};

export const cleanupLegacyStartKey = async () => {
  const store = getPublicStore();
  await store.remove(LEGACY_RECOVERY_KEY);
  await store.remove(LEGACY_RECOVERY_IDS);
  await store.remove(LEGACY_CONFIRM_KEY);
};

export const maskKey = (value: string, masked: boolean) => {
  if (!masked) return value;

  if (!value) return "";

  return "*".repeat(value.length);
};

export const copyStartKey = async (value: string) => {
  if (!value) return;
  await navigator.clipboard.writeText(value);
};

export const downloadStartKey = (value: string) => {
  if (!value) return;

  const blob = new Blob(
    [
      "NKC account recovery key\n\n",
      value,
      "\n\nKeep this file private. Anyone with this key may be able to access your account.\n",
    ],
    { type: "text/plain;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `NKC-recovery-key-${new Date().toISOString().slice(0, 10)}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
};
