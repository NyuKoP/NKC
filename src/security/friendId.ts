import { getPublicStore } from "./publicStore";

const SHARE_ID_KEY = "nkc_share_id_v1";
const SHARE_ID_PREFIX = "NCK-";

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
  const store = getPublicStore();
  const cached = await store.get(SHARE_ID_KEY);
  if (cached) return cached;
  try {
    const hashed = await hashId(userId);
    const shareId = `${SHARE_ID_PREFIX}${hashed.slice(0, 24)}`;
    await store.set(SHARE_ID_KEY, shareId);
    return shareId;
  } catch {
    const fallbackBytes = new Uint8Array(12);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(fallbackBytes);
    } else {
      for (let i = 0; i < fallbackBytes.length; i += 1) {
        fallbackBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const fallback = `${SHARE_ID_PREFIX}${toHex(fallbackBytes.buffer)}`;
    await store.set(SHARE_ID_KEY, fallback);
    return fallback;
  }
};
