import { getSecretStore } from "./secretStore";

const INVITE_PREFIX = "nkc_invite_used_v1:";
const memoryStore = new Map<string, string>();
const inviteLocks = new Map<string, Promise<void>>();

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

const withInviteLock = async <T>(fingerprint: string, work: () => Promise<T>) => {
  const key = `${INVITE_PREFIX}${fingerprint}`;
  const previous = inviteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  inviteLocks.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (inviteLocks.get(key) === queued) {
      inviteLocks.delete(key);
    }
  }
};

export const isInviteUsed = async (fingerprint: string) => {
  const value = await getSecret(`${INVITE_PREFIX}${fingerprint}`);
  return value === "1";
};

export const markInviteUsed = async (fingerprint: string) => {
  await setSecret(`${INVITE_PREFIX}${fingerprint}`, "1");
};

export const runOneTimeInviteGuard = async <T>(
  fingerprint: string,
  work: () => Promise<T>,
  shouldConsume: (value: T) => boolean = () => true
): Promise<{ ok: true; value: T } | { ok: false }> => {
  return withInviteLock(fingerprint, async () => {
    const used = await isInviteUsed(fingerprint);
    if (used) {
      return { ok: false } as const;
    }
    const value = await work();
    if (shouldConsume(value)) {
      await markInviteUsed(fingerprint);
    }
    return { ok: true, value } as const;
  });
};
