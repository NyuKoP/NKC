import { unifiedAppExperimentEnabled } from "../sync/unifiedAppPolicy";
import { notifyAccountOwnerChange } from "./accountOwnerLifecycle";

export type LocalAccount = {
  id: string;
  label: string;
  dbName: string;
  createdAt: number;
  lastUsedAt: number;
  legacy?: boolean;
};

const REGISTRY_KEY = "nkc_accounts_v1";

const ACTIVE_KEY = "nkc_active_account_v1";

const LEGACY_ID = "legacy";

const LEGACY_DB = unifiedAppExperimentEnabled() ? "nkc-phase2h-app-legacy" : "nkc_vault";

export const MAX_LOCAL_ACCOUNTS = 10;

export class LocalAccountLimitError extends Error {
  readonly code = "LOCAL_ACCOUNT_LIMIT_REACHED";

  constructor() {
    super(`이 기기에서는 계정을 최대 ${MAX_LOCAL_ACCOUNTS}개까지 만들 수 있습니다.`);
    this.name = "LocalAccountLimitError";
  }
}

const storage = () => {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readRegistry = (): LocalAccount[] => {
  const raw = storage()?.getItem(REGISTRY_KEY);

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LocalAccount[];

      if (Array.isArray(parsed) && parsed.length) {
        if (unifiedAppExperimentEnabled() && parsed.some((account) => !account.dbName.startsWith("nkc-phase2h-app-"))) {
          throw new Error("UNIFIED_PROFILE_BLOCKED");
        }

        return parsed;
      }
    } catch {
      // Recreate the registry without touching any vault database.
      if (unifiedAppExperimentEnabled()) throw new Error("UNIFIED_PROFILE_BLOCKED");
    }
  }

  const now = Date.now();

  const legacy: LocalAccount = {
    id: LEGACY_ID,
    label: "기존 계정",
    dbName: LEGACY_DB,
    createdAt: now,
    lastUsedAt: now,
    legacy: true,
  };

  storage()?.setItem(REGISTRY_KEY, JSON.stringify([legacy]));
  storage()?.setItem(ACTIVE_KEY, legacy.id);

  return [legacy];
};

const writeRegistry = (accounts: LocalAccount[]) => {
  storage()?.setItem(REGISTRY_KEY, JSON.stringify(accounts));
};

export const listLocalAccounts = () => readRegistry();

export const findMatchingLocalAccount = async (
  matches: (account: LocalAccount) => Promise<boolean>,
  preferredAccountId = getActiveAccountId()
) => {
  const accounts = readRegistry();

  const ordered = [
    ...accounts.filter((account) => account.id === preferredAccountId),
    ...accounts
      .filter((account) => account.id !== preferredAccountId)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt),
  ];

  for (const account of ordered) {
    if (await matches(account)) return account;
  }

  return null;
};

export const getActiveAccountId = () => {
  const accounts = readRegistry();
  const requested = storage()?.getItem(ACTIVE_KEY);

  return accounts.some((account) => account.id === requested) ? requested! : accounts[0].id;
};

export const getActiveAccount = () => {
  const accounts = readRegistry();

  return accounts.find((account) => account.id === getActiveAccountId()) ?? accounts[0];
};

export const activateAccount = (accountId: string) => {
  const accounts = readRegistry();
  const account = accounts.find((candidate) => candidate.id === accountId);

  if (!account) throw new Error("Unknown local account");
  notifyAccountOwnerChange();
  account.lastUsedAt = Date.now();
  writeRegistry(accounts);
  storage()?.setItem(ACTIVE_KEY, account.id);

  return account;
};

export const createLocalAccount = (label: string) => {
  const accounts = readRegistry();

  if (accounts.filter((account) => !account.legacy).length >= MAX_LOCAL_ACCOUNTS) {
    throw new LocalAccountLimitError();
  }

  const id = globalThis.crypto.randomUUID();
  notifyAccountOwnerChange();
  const now = Date.now();

  const account: LocalAccount = {
    id,
    label: label.trim() || "NKC 사용자",
    dbName: `${unifiedAppExperimentEnabled() ? "nkc-phase2h-app-" : "nkc_vault_"}${id.replace(/-/g, "")}`,
    createdAt: now,
    lastUsedAt: now,
  };

  accounts.push(account);
  writeRegistry(accounts);
  storage()?.setItem(ACTIVE_KEY, id);

  return account;
};

export const renameActiveAccount = (label: string) => {
  const accounts = readRegistry();
  const activeId = getActiveAccountId();
  const account = accounts.find((candidate) => candidate.id === activeId);

  if (!account) return;
  account.label = label.trim() || account.label;
  account.lastUsedAt = Date.now();
  writeRegistry(accounts);
};

export const removeLocalAccount = (accountId: string) => {
  notifyAccountOwnerChange();
  const accounts = readRegistry();
  const remaining = accounts.filter((account) => account.id !== accountId);
  writeRegistry(remaining);

  if (storage()?.getItem(ACTIVE_KEY) === accountId) {
    const fallback = remaining.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];

    if (fallback) storage()?.setItem(ACTIVE_KEY, fallback.id);
    else storage()?.removeItem(ACTIVE_KEY);
  }
};

export const scopeAccountKey = (key: string) => {
  const account = getActiveAccount();

  return account.legacy ? key : `nkc_account:${account.id}:${key}`;
};
