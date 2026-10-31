import Dexie, { type Table } from "dexie";
import type { MainAccountSession } from "../accounts/mainSessionTypes";
import { getActiveAccount } from "../accounts/accountRegistry";
import { getAccountOwnerGeneration, onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { getVaultKey, onVaultKeyChange } from "../crypto/sessionKeyring";
import { db, ensureDbOpen, type NKCVaultDB } from "./schema";

/** A reference to the existing unlocked vault, never another connection or copied key. */
export type VaultAccess = Readonly<{
  accountId: string;
  session: MainAccountSession;
  db: NKCVaultDB;
  key: Uint8Array;
  assertLocal: () => void;
  assertMain: () => Promise<void>;
  authorizationMeta?: Readonly<{ key: string; value: string }>;
}>;

export const captureVaultAccess = (session: MainAccountSession,
  validate: (session: MainAccountSession) => Promise<unknown>): VaultAccess => {
  const account = getActiveAccount();
  const key = getVaultKey();

  if (account.id !== session.accountId || db.name !== account.dbName || !key) {
    throw new Error("RECIPIENT_VAULT_UNAVAILABLE");
  }

  const selectedDb = db;
  const generation = getAccountOwnerGeneration();

  const assertLocal = () => {
    if (getAccountOwnerGeneration() !== generation || getVaultKey() !== key || db !== selectedDb ||
        getActiveAccount().id !== session.accountId) throw new Error("OWNER_SESSION_CHANGED");
  };

  return Object.freeze({ accountId: session.accountId, session, db: selectedDb, key, assertLocal,
    assertMain: async () => { assertLocal(); await validate(session); assertLocal(); } });
};

export const ensureVaultAccess = async (access?: VaultAccess) => {
  if (!access) return ensureDbOpen();
  await access.assertMain();

  if (!access.db.isOpen()) throw new Error("RECIPIENT_VAULT_UNAVAILABLE");

  return access.db;
};

/** Reuse the vault transaction; revoke/replace aborts it rather than redirecting a write. */
export const writeVault = async <T>(access: VaultAccess | undefined, tables: Table[],
  work: () => Promise<T>, authorizationValueAfter?: string): Promise<T> => {
  if (!access) return work();

  if (Dexie.currentTransaction?.db === access.db) await Dexie.waitFor(access.assertMain());
  else await access.assertMain();
  let stopAccount = () => {};

  let stopKey = () => {};
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("OWNER_SESSION_CHANGED")); });

  try {
    const operation = access.db.transaction("rw", access.authorizationMeta ? [...tables, access.db.meta] : tables, async transaction => {
      const abort = () => {
        if (!transaction.active) return;
        try { transaction.abort(); }
        catch (error) { if (!(error instanceof Error) || error.name !== "InvalidStateError") throw error; }
        // Native IndexedDB can finish before Dexie updates its active flag; still reject the old owner.
        finally { cancel(); }
      };

      stopAccount = onAccountOwnerChange(abort);
      stopKey = onVaultKeyChange(abort);
      access.assertLocal();

      if (access.authorizationMeta && (await access.db.meta.get(access.authorizationMeta.key))?.value !== access.authorizationMeta.value) {
        throw new Error("DEVICE_AUTHORITY_CHANGED");
      }

      // Only IndexedDB work belongs here; never waitFor a callback that uses this transaction.
      const result = await work();

      if (access.authorizationMeta && (await access.db.meta.get(access.authorizationMeta.key))?.value !== (authorizationValueAfter ?? access.authorizationMeta.value)) {
        throw new Error("DEVICE_AUTHORITY_CHANGED");
      }

      await Dexie.waitFor(access.assertMain());
      access.assertLocal();

      return result;
    });
    // Dexie.waitFor's IndexedDB spin can stop on abort before its scope Promise settles.
    return await Promise.race([operation, cancelled]);
  } finally {
    stopAccount();
    stopKey();
  }
};
