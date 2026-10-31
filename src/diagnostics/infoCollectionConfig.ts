const parseEnabled = (raw: unknown) => {
  if (raw === undefined || raw === null) return true;
  const normalized = String(raw).trim().toLowerCase();

  return normalized !== "0" && normalized !== "false" && normalized !== "off";
};

const meta = import.meta;

const env = "env" in meta ? meta.env : undefined;

export const INFO_COLLECTION_ENABLED = parseEnabled(
  env && typeof env === "object" && "VITE_INFO_COLLECTION_LOGS" in env
    ? env.VITE_INFO_COLLECTION_LOGS
    : undefined
);

export const isInfoCollectionEnabled = () => INFO_COLLECTION_ENABLED;
