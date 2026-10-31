import { scopeAccountKey } from "../accounts/accountRegistry";
import type { MainAccountSession } from "../accounts/mainSessionTypes";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { acquireMainAccountSession } from "../accounts/accountOwnerLifecycle";

export type SecretStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, expected?: { value: string | null }) => Promise<void>;
  readonly conditionalWrites?: boolean;
  remove: (key: string) => Promise<void>;
  ratchetSnapshot?: (accountId: string, channel: string, version: 1 | 2) => Promise<{
    value: string | null; revision: number; fingerprint: string | null;
  }>;
  ratchetCommit?: (request: { accountId: string; channel: string; version: 1 | 2;
    expectedRevision: number; expectedFingerprint: string | null; nextValue: string }) => Promise<void>;
};

type ElectronSecureStorageApi = {
  getOwned?: (session: MainAccountSession, key: string) => Promise<string | null>;
  setOwned?: (session: MainAccountSession, key: string, value: string, expected?: { value: string | null }) => Promise<boolean>;
  removeOwned?: (session: MainAccountSession, key: string) => Promise<boolean>;
  isAvailable: () => Promise<boolean>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<boolean>;
  remove: (key: string) => Promise<boolean>;
  ratchetSnapshot?: NonNullable<SecretStore["ratchetSnapshot"]>;
  ratchetCommit?: (request: { accountId: string; channel: string; version: 1 | 2;
    expectedRevision: number; expectedFingerprint: string | null; nextValue: string }) => Promise<unknown>;
};

const getElectronSecureStorage = (): ElectronSecureStorageApi | null => {
  if (typeof window === "undefined") return null;

  return window.electron?.secureStorage ?? null;
};

const rethrowWriteFailure = (error: unknown): never => {
  const message = error instanceof Error ? error.message : "";

  for (const code of ["OWNER_REQUIRED", "SECRET_STORE_ACCOUNT_DELETED", "STALE_OWNER_REVISION",
    "PRIOR_STATE_MISMATCH", "UNOWNED_LEGACY_STATE", "OWNER_SESSION_CHANGED", "OWNER_ACCOUNT_MISMATCH", "ROLLBACK_SUSPECTED", "RATCHET_PRIOR_PROCESS"]) {
    if (message.includes(code)) throw new Error(code);
  }

  throw new Error("SECRET_STORE_WRITE_FAILED");
};

class ElectronSecretStore implements SecretStore {
  private api: ElectronSecureStorageApi;
  private owner?: Promise<MainAccountSession>;
  private namespace?: string;

  constructor(api: ElectronSecureStorageApi, owner?: Promise<MainAccountSession>, namespace?: string) {
    this.api = api;
    this.owner = owner;
    this.namespace = namespace;
  }

  private ownedKey(session: MainAccountSession, key: string) {
    const namespace = this.namespace ?? session.accountId;

    if (namespace.toLowerCase() !== session.accountId) throw new Error("OWNER_ACCOUNT_MISMATCH");

    return namespace === "legacy" ? key : `nkc_account:${namespace}:${key}`;
  }

  async get(key: string) {
    try {
      if (this.owner) {
        const session = await this.owner;

        if (!this.api.getOwned) throw new Error("OWNER_REQUIRED");

        return await this.api.getOwned(session, this.ownedKey(session, key));
      }

      return await this.api.get(scopeAccountKey(key));
    }
    catch (error) {
      const message = error instanceof Error ? error.message : "";

      if (message.includes("OWNER_") || message.includes("SECRET_STORE_ACCOUNT_DELETED") || message.includes("ROLLBACK_SUSPECTED")) rethrowWriteFailure(error);
      throw new Error(message.includes("SECRET_STORE_DECRYPT_FAILED") ? "SECRET_STORE_DECRYPT_FAILED"
        : message.includes("SECRET_STORE_UNAVAILABLE") ? "SECRET_STORE_UNAVAILABLE" : "SECRET_STORE_READ_FAILED");
    }
  }

  get conditionalWrites() { return Boolean(this.owner); }

  async set(key: string, value: string, expected?: { value: string | null }) {
    try {
      const session = this.owner ? await this.owner : null;

      if (session && !this.api.setOwned) throw new Error("OWNER_REQUIRED");

      const written = session ? await this.api.setOwned!(session,
        this.ownedKey(session, key), value, expected)
        : await this.api.set(scopeAccountKey(key), value);

      if (!written) throw new Error("SECRET_STORE_WRITE_FAILED");
    }
    catch (error) { rethrowWriteFailure(error); }
  }

  async remove(key: string) {
    try {
      const session = this.owner ? await this.owner : null;

      if (session && !this.api.removeOwned) throw new Error("OWNER_REQUIRED");

      const removed = session ? await this.api.removeOwned!(session,
        this.ownedKey(session, key))
        : await this.api.remove(scopeAccountKey(key));

      if (!removed) throw new Error("SECRET_STORE_WRITE_FAILED");
    }
    catch (error) { rethrowWriteFailure(error); }
  }

  async ratchetSnapshot(accountId: string, channel: string, version: 1 | 2) {
    if (!this.api.ratchetSnapshot) throw new Error("OWNER_REQUIRED");

    try { return await this.api.ratchetSnapshot(accountId, channel, version); }
    catch (error) {
      if (error instanceof Error && error.message.includes("ROLLBACK_SUSPECTED")) throw new Error("ROLLBACK_SUSPECTED");
      throw error;
    }
  }

  async ratchetCommit(request: { accountId: string; channel: string; version: 1 | 2;
    expectedRevision: number; expectedFingerprint: string | null; nextValue: string }) {
    if (!this.api.ratchetCommit) throw new Error("OWNER_REQUIRED");

    try { await this.api.ratchetCommit(request); }
    catch (error) {
      if (error instanceof Error && error.message.includes("ROLLBACK_SUSPECTED")) throw new Error("ROLLBACK_SUSPECTED");
      throw error;
    }
  }

}

export const isSecretStoreAvailable = async () => {
  const api = getElectronSecureStorage();

  if (!api?.isAvailable) return false;

  try {
    return await api.isAvailable();
  } catch {
    return false;
  }
};

export const getSecretStore = (session?: MainAccountSession) => {
  const api = getElectronSecureStorage();

  if (!api) {
    throw new Error("SECRET_STORE_UNAVAILABLE");
  }

  const namespace = session?.accountId ?? getActiveAccountId();

  const owner = session ? Promise.resolve(session) : typeof window !== "undefined" && window.nkc?.activateAccountSession
    ? acquireMainAccountSession(namespace) : undefined;

  return new ElectronSecretStore(api, owner, namespace);
};
