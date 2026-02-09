import type { RendezvousConfig } from "./rendezvousSignaling";

const DEFAULT_RENDEZVOUS_BASE_URL = "https://rendezvous.nkc.im";
const RENDEZVOUS_BASE_URL_KEY = "rendezvous_base_url_v1";
const RENDEZVOUS_USE_ONION_KEY = "rendezvous_use_onion_v1";

const readRendererEnv = () =>
  (import.meta as {
    env?: {
      VITE_RENDEZVOUS_BASE_URL?: string;
      VITE_RENDEZVOUS_USE_ONION?: string;
    };
  }).env;

const parseBooleanFlag = (value?: string) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const readStoredValue = (key: string) => {
  try {
    return globalThis.window?.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
};

export const resolveInternalRendezvousConfig = (): RendezvousConfig => {
  const env = readRendererEnv();
  const storedBaseUrl = readStoredValue(RENDEZVOUS_BASE_URL_KEY).trim();
  const storedUseOnionRaw = readStoredValue(RENDEZVOUS_USE_ONION_KEY).trim();
  const envBaseUrl = (env?.VITE_RENDEZVOUS_BASE_URL ?? "").trim();
  const baseUrl = storedBaseUrl || envBaseUrl || DEFAULT_RENDEZVOUS_BASE_URL;
  const useOnionProxy = storedUseOnionRaw
    ? parseBooleanFlag(storedUseOnionRaw)
    : parseBooleanFlag(env?.VITE_RENDEZVOUS_USE_ONION);
  return {
    baseUrl,
    useOnionProxy,
    onionProxyUrl: null,
  };
};
