/** Initial product policy: each local device/account has its own budget. */
export const HISTORY_STORAGE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Must remain disabled until accounting, atomic admission and Phase 2 qualify together. */
export const HISTORY_STORAGE_ENFORCEMENT_ENABLED = false;

export type HistoryStorageWarning = "none" | "75_percent" | "90_percent" | "at_capacity";

/** Only pass deduplicated History-related bytes, never all ordinary account traffic. */
export function historyStorageBudgetStatus(usedBytes: number, reservedBytes = 0) {
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 ||
      !Number.isSafeInteger(reservedBytes) || reservedBytes < 0 ||
      !Number.isSafeInteger(usedBytes + reservedBytes)) throw new Error("INVALID_HISTORY_STORAGE_USAGE");

  const committedAndReservedBytes = usedBytes + reservedBytes;

  const warning: HistoryStorageWarning = committedAndReservedBytes >= HISTORY_STORAGE_BUDGET_BYTES ? "at_capacity"
    : committedAndReservedBytes >= HISTORY_STORAGE_BUDGET_BYTES * 0.9 ? "90_percent"
    : committedAndReservedBytes >= HISTORY_STORAGE_BUDGET_BYTES * 0.75 ? "75_percent" : "none";

  return { budgetBytes: HISTORY_STORAGE_BUDGET_BYTES, usedBytes, reservedBytes, warning,
    remainingBytes: Math.max(0, HISTORY_STORAGE_BUDGET_BYTES - committedAndReservedBytes),
    enforcementEnabled: HISTORY_STORAGE_ENFORCEMENT_ENABLED };
}
