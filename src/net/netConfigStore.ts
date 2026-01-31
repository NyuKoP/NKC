import { create } from "zustand";
import type { NetConfig } from "./netConfig";
import { DEFAULT_NET_CONFIG } from "./netConfig";
import type { NetworkMode } from "./mode";

const STORAGE_KEY = "netConfig.v1";

const getStorage = () => {
  if (typeof window !== "undefined") return window.localStorage;
  if (typeof globalThis !== "undefined") {
    return (globalThis as { localStorage?: Storage }).localStorage;
  }
  return undefined;
};

const migrateMode = (mode?: string): NetworkMode => {
  if (!mode) return DEFAULT_NET_CONFIG.mode;
  if (mode === "selfOnion" || mode === "onionRouter") return mode;
  if (mode === "directP2P") return "selfOnion";
  return DEFAULT_NET_CONFIG.mode;
};

const clampSelfOnionRelays = (value: number) => Math.max(3, Math.min(4, value));

const loadStoredConfig = (): NetConfig => {
  const storage = getStorage();
  if (!storage) return DEFAULT_NET_CONFIG;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_NET_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<NetConfig>;
    const migratedMode = migrateMode(parsed.mode as string | undefined);
    const next = { ...DEFAULT_NET_CONFIG, ...parsed, mode: migratedMode };
    return { ...next, selfOnionMinRelays: clampSelfOnionRelays(next.selfOnionMinRelays) };
  } catch (error) {
    console.error("Failed to read net config", error);
    storage.removeItem(STORAGE_KEY);
    return DEFAULT_NET_CONFIG;
  }
};

const persistConfig = (config: NetConfig) => {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(config));
};

export const enforceRules = (config: NetConfig): NetConfig => {
  if (config.mode === "onionRouter" || config.onionEnabled) {
    return {
      ...config,
      mode: "onionRouter",
      onionProxyEnabled: true,
      webrtcRelayOnly: true,
      disableLinkPreview: true,
    };
  }
  return config;
};

type NetConfigState = {
  config: NetConfig;
  setMode: (mode: NetworkMode) => void;
  setProxy: (enabled: boolean, url?: string) => void;
  setRelayOnly: (value: boolean) => void;
  setDisableLinkPreview: (value: boolean) => void;
  setSelfOnionEnabled: (value: boolean) => void;
  setSelfOnionMinRelays: (value: number) => void;
  setOnionEnabled: (value: boolean) => void;
  setOnionNetwork: (value: NetConfig["onionSelectedNetwork"]) => void;
  setComponentState: (
    network: NetConfig["onionSelectedNetwork"],
    state: Partial<NetConfig["tor"]>
  ) => void;
  setLastUpdateCheckAt: (value: number | undefined) => void;
  setConfig: (next: NetConfig) => void;
};

export const useNetConfigStore = create<NetConfigState>((set, get) => ({
  config: enforceRules(loadStoredConfig()),
  setMode: (mode) => {
    const next = enforceRules({
      ...get().config,
      mode,
      onionEnabled: mode === "onionRouter" ? get().config.onionEnabled : false,
    });
    persistConfig(next);
    set({ config: next });
  },
  setProxy: (enabled, url) => {
    const next = enforceRules({
      ...get().config,
      onionProxyEnabled: enabled,
      onionProxyUrl: url ?? get().config.onionProxyUrl,
    });
    persistConfig(next);
    set({ config: next });
  },
  setRelayOnly: (value) => {
    const next = enforceRules({ ...get().config, webrtcRelayOnly: value });
    persistConfig(next);
    set({ config: next });
  },
  setDisableLinkPreview: (value) => {
    const next = enforceRules({ ...get().config, disableLinkPreview: value });
    persistConfig(next);
    set({ config: next });
  },
  setSelfOnionEnabled: (value) => {
    const next = enforceRules({ ...get().config, selfOnionEnabled: value });
    persistConfig(next);
    set({ config: next });
  },
  setSelfOnionMinRelays: (value) => {
    const next = enforceRules({
      ...get().config,
      selfOnionMinRelays: clampSelfOnionRelays(value),
    });
    persistConfig(next);
    set({ config: next });
  },
  setOnionEnabled: (value) => {
    const next = enforceRules({ ...get().config, onionEnabled: value });
    persistConfig(next);
    set({ config: next });
  },
  setOnionNetwork: (value) => {
    const next = enforceRules({ ...get().config, onionSelectedNetwork: value });
    persistConfig(next);
    set({ config: next });
  },
  setComponentState: (network, state) => {
    const current = get().config;
    const next = enforceRules({
      ...current,
      [network]: { ...current[network], ...state },
    });
    persistConfig(next);
    set({ config: next });
  },
  setLastUpdateCheckAt: (value) => {
    const next = enforceRules({ ...get().config, lastUpdateCheckAtMs: value });
    persistConfig(next);
    set({ config: next });
  },
  setConfig: (next) => {
    const enforced = enforceRules({
      ...next,
      selfOnionMinRelays: clampSelfOnionRelays(next.selfOnionMinRelays),
    });
    persistConfig(enforced);
    set({ config: enforced });
  },
}));
