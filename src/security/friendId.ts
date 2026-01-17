import { getSecureStore } from "./secureStore";

const SHARE_ID_KEY = "nkc_share_id_v1";

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const hashId = async (value: string) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Crypto subtle is unavailable.");
  }
  const data = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
};

export const getShareId = async (userId: string) => {
  const store = getSecureStore();
  const cached = await store.get(SHARE_ID_KEY);
  if (cached) return cached;
  try {
    const hashed = await hashId(userId);
    const shareId = `NKC-${hashed.slice(0, 24)}`;
    await store.set(SHARE_ID_KEY, shareId);
    return shareId;
  } catch (error) {
    console.error("Failed to derive share ID", error);
    const fallback = `NKC-${userId.slice(0, 12)}`;
    await store.set(SHARE_ID_KEY, fallback);
    return fallback;
  }
};
