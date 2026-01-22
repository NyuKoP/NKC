import { getPublicStore } from "./publicStore";

export type PrivacyPreferences = {
  readReceipts: boolean;
  typingIndicator: boolean;
  linkPreviews: boolean;
};

const PREF_KEY = "nkc_privacy_prefs_v1";
const CONV_DIRECT_ALLOW_PREFIX = "nkc_conv_allow_direct_v1:";
const RENDEZVOUS_BASE_URL_KEY = "rendezvous_base_url_v1";
const RENDEZVOUS_USE_ONION_KEY = "rendezvous_use_onion_v1";
const ONION_CONTROLLER_URL_KEY = "onion_controller_url_v1";

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

export const getConvAllowDirect = async (convId: string) => {
  const store = getPublicStore();
  const raw = await store.get(`${CONV_DIRECT_ALLOW_PREFIX}${convId}`);
  return raw === "true";
};

export const setConvAllowDirect = async (convId: string, value: boolean) => {
  const store = getPublicStore();
  await store.set(`${CONV_DIRECT_ALLOW_PREFIX}${convId}`, value ? "true" : "false");
};

export const getRendezvousBaseUrl = async () => {
  const store = getPublicStore();
  return (await store.get(RENDEZVOUS_BASE_URL_KEY)) ?? "";
};

export const setRendezvousBaseUrl = async (value: string) => {
  const store = getPublicStore();
  await store.set(RENDEZVOUS_BASE_URL_KEY, value);
};

export const getRendezvousUseOnion = async () => {
  const store = getPublicStore();
  const raw = await store.get(RENDEZVOUS_USE_ONION_KEY);
  return raw === "true";
};

export const setRendezvousUseOnion = async (value: boolean) => {
  const store = getPublicStore();
  await store.set(RENDEZVOUS_USE_ONION_KEY, value ? "true" : "false");
};

export const getOnionControllerUrlOverride = async () => {
  const store = getPublicStore();
  return (await store.get(ONION_CONTROLLER_URL_KEY)) ?? "";
};

export const setOnionControllerUrlOverride = async (value: string) => {
  const store = getPublicStore();
  const trimmed = value.trim();
  if (!trimmed) {
    await store.remove(ONION_CONTROLLER_URL_KEY);
    return;
  }
  await store.set(ONION_CONTROLLER_URL_KEY, trimmed);
};
