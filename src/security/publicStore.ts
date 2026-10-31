export type PublicStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export class LocalStoragePublicStore implements PublicStore {
  private owner?: Pick<VaultAccess, "accountId" | "assertLocal" | "assertMain">;
  constructor(owner?: Pick<VaultAccess, "accountId" | "assertLocal" | "assertMain">) { this.owner = owner; }

  private key(key: string) {
    this.owner?.assertLocal();

    return this.owner ? this.owner.accountId === "legacy" ? key : `nkc_account:${this.owner.accountId}:${key}` : scopeAccountKey(key);
  }
  async get(key: string) {
    await this.owner?.assertMain();
    key = this.key(key);

    try {
      return window.localStorage.getItem(key);
    } catch {
      if (this.owner) throw new Error("PUBLIC_STORE_READ_FAILED");

      return null;
    }
  }

  async set(key: string, value: string) {
    await this.owner?.assertMain();
    key = this.key(key);

    try {
      window.localStorage.setItem(key, value);
    } catch {
      if (this.owner) throw new Error("PUBLIC_STORE_WRITE_FAILED");

      return;
    }
  }

  async remove(key: string) {
    await this.owner?.assertMain();
    key = this.key(key);

    try {
      window.localStorage.removeItem(key);
    } catch {
      if (this.owner) throw new Error("PUBLIC_STORE_WRITE_FAILED");

      return;
    }
  }
}

let cachedStore: PublicStore | null = null;

export const getPublicStore = (owner?: Pick<VaultAccess, "accountId" | "assertLocal" | "assertMain">) => {
  if (owner) return new LocalStoragePublicStore(owner);

  if (cachedStore) return cachedStore;
  cachedStore = new LocalStoragePublicStore();

  return cachedStore;
};

import { scopeAccountKey } from "../accounts/accountRegistry";
import type { VaultAccess } from "../db/vaultAccess";
