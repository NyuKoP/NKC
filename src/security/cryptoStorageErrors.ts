/** Storage failure is not evidence that a peer needs an older crypto mode. */
export const throwIfCryptoStorageFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";

  if (/SECRET_STORE_|RATCHET_STATE_INVALID|RATCHET_PRIOR_PROCESS|PSK_STATE_INVALID|OWNER_|STALE_OWNER_REVISION|PRIOR_STATE_MISMATCH|ROLLBACK_SUSPECTED|UNOWNED_LEGACY_STATE|SecretStore (?:unavailable|set failed|remove failed)/.test(message)) throw error;
};
