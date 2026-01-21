import { getPublicStore } from "./publicStore";

export type PrivacyPreferences = {
  readReceipts: boolean;
  typingIndicator: boolean;
  linkPreviews: boolean;
};

const PREF_KEY = "nkc_privacy_prefs_v1";
const DIRECT_P2P_ACK_KEY = "directP2P_ack_risk_v1";
const CONV_DIRECT_ALLOW_PREFIX = "nkc_conv_allow_direct_v1:";

export const defaultPrivacyPrefs: PrivacyPreferences = {
  readReceipts: false,
  typingIndicator: true,
  linkPreviews: true,
};

export const getPrivacyPrefs = async () => {
  const store = getPublicStore();
  const raw = await store.get(PREF_KEY);
  if (!raw) return defaultPrivacyPrefs;
  try {
    const parsed = JSON.parse(raw) as Partial<PrivacyPreferences>;
    return { ...defaultPrivacyPrefs, ...parsed };
  } catch (error) {
    console.error("Failed to read privacy prefs", error);
    await store.remove(PREF_KEY);
    return defaultPrivacyPrefs;
  }
};

export const setPrivacyPrefs = async (prefs: PrivacyPreferences) => {
  const store = getPublicStore();
  await store.set(PREF_KEY, JSON.stringify({ ...prefs, updatedAt: Date.now() }));
};

export const getDirectP2PRiskAck = async () => {
  const store = getPublicStore();
  const raw = await store.get(DIRECT_P2P_ACK_KEY);
  return raw === "true";
};

export const setDirectP2PRiskAck = async (value: boolean) => {
  const store = getPublicStore();
  await store.set(DIRECT_P2P_ACK_KEY, value ? "true" : "false");
};

export const getConvAllowDirect = async (convId: string) => {
  const store = getPublicStore();
  const raw = await store.get(`${CONV_DIRECT_ALLOW_PREFIX}${convId}`);
  return raw === "true";
};

export const setConvAllowDirect = async (convId: string, value: boolean) => {
  const store = getPublicStore();
  await store.set(`${CONV_DIRECT_ALLOW_PREFIX}${convId}`, value ? "true" : "false");
};
