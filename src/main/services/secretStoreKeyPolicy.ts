const SECRET_STORE_EXACT_KEYS = new Set([
  "nkc_identity_priv_v1",
  "nkc_dh_priv_v1",
  "nkc_session_v1",
  "nkc_pin_v1",
  "nkc_pin_reset_v1",
  "nkc_start_key_v1",
]);

const SECRET_STORE_PREFIXES = [
  "nkc_friend_psk_v1:",
  "nkc_invite_used_v1:",
  "nkc_ratchet_v1:",
  "nkc_ratchet_v2:",
];

const ACCOUNT_SCOPE_PREFIX = "nkc_account:";

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isAllowedInnerKey = (key: string) =>
  key.length > 0 &&
  key.length <= 256 &&
  (SECRET_STORE_EXACT_KEYS.has(key) ||
    SECRET_STORE_PREFIXES.some((prefix) => key.startsWith(prefix)));

export const isAllowedSecretStoreKey = (key: unknown): key is string => {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return false;

  if (!key.startsWith(ACCOUNT_SCOPE_PREFIX)) return isAllowedInnerKey(key);

  const separatorIndex = key.indexOf(":", ACCOUNT_SCOPE_PREFIX.length);

  if (separatorIndex < 0) return false;
  const accountId = key.slice(ACCOUNT_SCOPE_PREFIX.length, separatorIndex);
  const innerKey = key.slice(separatorIndex + 1);

  return ACCOUNT_ID_PATTERN.test(accountId) && isAllowedInnerKey(innerKey);
};
