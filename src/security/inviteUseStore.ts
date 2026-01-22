import { getSecretStore } from "./secretStore";

const INVITE_PREFIX = "nkc_invite_used_v1:";
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

export const isInviteUsed = async (fingerprint: string) => {
  const value = await getSecret(`${INVITE_PREFIX}${fingerprint}`);
  return value === "1";
};

export const markInviteUsed = async (fingerprint: string) => {
  await setSecret(`${INVITE_PREFIX}${fingerprint}`, "1");
};
