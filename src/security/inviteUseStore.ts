import { getSecretStore } from "./secretStore";

const INVITE_PREFIX = "nkc_invite_used_v1:";

const inviteLocks = new Map<string, Promise<void>>();

const getSecret = (key: string) => getSecretStore().get(key);

const setSecret = (key: string, value: string) => getSecretStore().set(key, value);

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
  shouldConsume: (value: T) => boolean = () => true,
  legacyFingerprints: readonly string[] = []
): Promise<{ ok: true; value: T } | { ok: false }> => {
  const store = getSecretStore();
  const key = `${INVITE_PREFIX}${fingerprint}`;
  return withInviteLock(fingerprint, async () => {
    const used = (await store.get(key)) === "1";

    if (used) {
      return { ok: false } as const;
    }

    // Migrate a pre-canonicalization marker for this exact submitted spelling.
    // Unknown historical spelling-only digests cannot be reverse-migrated here.
    for (const legacy of new Set(legacyFingerprints)) {
      if (legacy !== fingerprint && (await store.get(`${INVITE_PREFIX}${legacy}`)) === "1") {
        await store.set(key, "1");
        return { ok: false } as const;
      }
    }

    const value = await work();

    if (shouldConsume(value)) {
      await store.set(key, "1");
    }

    return { ok: true, value } as const;
  });
};
