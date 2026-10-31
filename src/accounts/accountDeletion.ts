import type { LocalAccount } from "./accountRegistry";
import { acquireMainAccountSession } from "./accountOwnerLifecycle";

const LEGACY_PUBLIC_KEYS = new Set([
  "nkc_start_key_confirmed_v1",
  "nkc_recovery_confirmed_v1",
  "recovery_key_v1",
  "recovery_key_ids_v1",
  "nkc_identity_pub_v1",
  "nkc_dh_pub_v1",
  "nkc_device_id_v1",
  "nkc_device_role_v1",
  "nkc_role_epoch_v1",
  "nkc_primary_device_id_v1",
  "nkc_share_id_v1",
  "nkc_device_approvals_v1",
  "nkc_device_registry_v1",
  "nkc_privacy_prefs_v1",
  "nkc_trust_state_v1",
]);

const LEGACY_PUBLIC_PREFIXES = [
  "nkc_conv_allow_direct_v1:",
  "nkc_group_avatar_override_v1:",
];

export const removeAccountLocalStorage = (account: LocalAccount) => {
  if (typeof window === "undefined") return;
  const keys: string[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);

    if (key) keys.push(key);
  }

  const scopedPrefix = `nkc_account:${account.id}:`;

  for (const key of keys) {
    const shouldRemove = account.legacy
      ? LEGACY_PUBLIC_KEYS.has(key) || LEGACY_PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix))
      : key.startsWith(scopedPrefix);

    if (shouldRemove) window.localStorage.removeItem(key);
  }
};

export const removeAccountSecrets = async (account: LocalAccount) => {
  const secureStorage = window.electron?.secureStorage;

  if (!secureStorage) return;
  const session = window.nkc?.activateAccountSession ? await acquireMainAccountSession(account.id) : undefined;
  const removed = await secureStorage.removeAccount(account.id, session);

  if (!removed) throw new Error("Failed to remove account secrets");
};
