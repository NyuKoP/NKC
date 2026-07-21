const parseEnabled = (raw: unknown) => {
  if (raw === undefined || raw === null) return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
};

export const INFO_COLLECTION_ENABLED = parseEnabled(
  (import.meta as { env?: Record<string, unknown> }).env?.VITE_INFO_COLLECTION_LOGS
);

export const isInfoCollectionEnabled = () => INFO_COLLECTION_ENABLED;
