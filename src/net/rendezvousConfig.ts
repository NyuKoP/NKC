import type { RendezvousConfig } from "./rendezvousSignaling";

const DEFAULT_RENDEZVOUS_BASE_URL = "https://rendezvous.nkc.im";

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

export const resolveInternalRendezvousConfig = (): RendezvousConfig => {
  const env = readRendererEnv();
  const baseUrl = (env?.VITE_RENDEZVOUS_BASE_URL ?? "").trim() || DEFAULT_RENDEZVOUS_BASE_URL;
  return {
    baseUrl,
    useOnionProxy: parseBooleanFlag(env?.VITE_RENDEZVOUS_USE_ONION),
    onionProxyUrl: null,
  };
};

