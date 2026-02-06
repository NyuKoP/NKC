import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_NET_CONFIG } from "../netConfig";
import { enforceRules, useNetConfigStore } from "../netConfigStore";

const createStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
};

describe("netConfigStore", () => {
  const storage = createStorage();

  beforeEach(() => {
    storage.clear();
    (globalThis as unknown as { localStorage?: Storage }).localStorage = storage as Storage;
    useNetConfigStore.setState({ config: { ...DEFAULT_NET_CONFIG } });
  });

  it("enforces onion router rules", () => {
    const enforced = enforceRules({
      ...DEFAULT_NET_CONFIG,
      mode: "onionRouter",
      onionProxyEnabled: false,
      webrtcRelayOnly: false,
      disableLinkPreview: false,
    });
    expect(enforced.onionProxyEnabled).toBe(true);
    expect(enforced.webrtcRelayOnly).toBe(true);
    expect(enforced.disableLinkPreview).toBe(true);
  });

  it("persists config changes", () => {
    useNetConfigStore.getState().setMode("onionRouter");
    const raw = storage.getItem("netConfig.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as typeof DEFAULT_NET_CONFIG;
    expect(parsed.mode).toBe("onionRouter");
    expect(parsed.onionProxyEnabled).toBe(true);
    expect(parsed.disableLinkPreview).toBe(true);
  });

  it("allows directP2P mode without forcing onion router", () => {
    useNetConfigStore.getState().setMode("directP2P");
    const raw = storage.getItem("netConfig.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as typeof DEFAULT_NET_CONFIG;
    expect(parsed.mode).toBe("directP2P");
    expect(parsed.onionEnabled).toBe(false);
  });
});
