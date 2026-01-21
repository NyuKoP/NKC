import { getSecretStore } from "./secretStore";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

const PSK_PREFIX = "nkc_friend_psk_v1:";
const memoryStore = new Map<string, string>();

const getSecret = async (key: string) => {
  try {
    const store = getSecretStore();
    return await store.get(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
};

const setSecret = async (key: string, value: string) => {
  try {
    const store = getSecretStore();
    await store.set(key, value);
    return;
  } catch {
    memoryStore.set(key, value);
  }
};

const removeSecret = async (key: string) => {
  try {
    const store = getSecretStore();
    await store.remove(key);
    return;
  } catch {
    memoryStore.delete(key);
  }
};

export const setFriendPsk = async (friendId: string, psk: Uint8Array) => {
  await setSecret(`${PSK_PREFIX}${friendId}`, encodeBase64Url(psk));
};

export const getFriendPsk = async (friendId: string) => {
  const raw = await getSecret(`${PSK_PREFIX}${friendId}`);
  if (!raw) return null;
  try {
    return decodeBase64Url(raw);
  } catch {
    return null;
  }
};

export const clearFriendPsk = async (friendId: string) => {
  await removeSecret(`${PSK_PREFIX}${friendId}`);
};
