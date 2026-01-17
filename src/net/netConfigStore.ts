import { create } from "zustand";
import type { NetConfig } from "./netConfig";
import { DEFAULT_NET_CONFIG } from "./netConfig";
import type { NetworkMode } from "./mode";

const STORAGE_KEY = "netConfig.v1";

const loadStoredConfig = (): NetConfig => {
  if (typeof window === "undefined") return DEFAULT_NET_CONFIG;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_NET_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<NetConfig>;
    return { ...DEFAULT_NET_CONFIG, ...parsed };
  } catch (error) {
    console.error("Failed to read net config", error);
    window.localStorage.removeItem(STORAGE_KEY);
    return DEFAULT_NET_CONFIG;
  }
};

const persistConfig = (config: NetConfig) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
};

export const enforceRules = (config: NetConfig): NetConfig => {
  if (config.mode === "onionRouter") {
    return {
      ...config,
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
  setConfig: (next: NetConfig) => void;
};

export const useNetConfigStore = create<NetConfigState>((set, get) => ({
  config: enforceRules(loadStoredConfig()),
  setMode: (mode) => {
    const next = enforceRules({ ...get().config, mode });
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
    const next = enforceRules({ ...get().config, selfOnionMinRelays: value });
    persistConfig(next);
    set({ config: next });
  },
  setConfig: (next) => {
    const enforced = enforceRules(next);
    persistConfig(enforced);
    set({ config: enforced });
  },
}));
