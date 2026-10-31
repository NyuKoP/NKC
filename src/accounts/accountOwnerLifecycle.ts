import type { MainAccountSession } from "./mainSessionTypes";

const listeners = new Set<() => void>();

let generation = 0;

let mainTransition = Promise.resolve();

let mainSession: { accountId: string; generation: number; result: Promise<MainAccountSession> } | null = null;

export const getAccountOwnerGeneration = () => generation;

export const bumpAccountOwnerGeneration = () => {
  generation += 1;
  mainSession = null;
  const revoke = typeof window === "undefined" ? undefined : window.nkc?.revokeAccountSession;

  if (revoke) mainTransition = mainTransition.catch(() => {}).then(revoke);
  void mainTransition.catch(() => console.warn("[account] Main session revocation failed"));
};

/** UI lifecycle handle only; future receives must carry their own immutable operation context. */
export const acquireMainAccountSession = (accountId: string): Promise<MainAccountSession> => {
  if (mainSession?.accountId === accountId && mainSession.generation === generation) return mainSession.result;
  const activate = typeof window === "undefined" ? undefined : window.nkc?.activateAccountSession;

  if (!activate) return Promise.reject(new Error("OWNER_REQUIRED"));
  const capturedGeneration = generation;

  const result = (async () => {
    await mainTransition;

    if (generation !== capturedGeneration) throw new Error("OWNER_SESSION_CHANGED");
    const session = await activate(accountId);

    if (generation !== capturedGeneration) throw new Error("OWNER_SESSION_CHANGED");

    return session;
  })();

  mainSession = { accountId, generation: capturedGeneration, result };
  void result.catch(() => { if (mainSession?.result === result) mainSession = null; });

  return result;
};

export const onAccountOwnerChange = (listener: () => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

export const notifyAccountOwnerChange = () => {
  bumpAccountOwnerGeneration();
  listeners.forEach((listener) => listener());
};
