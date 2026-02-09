import { afterEach, describe, expect, it } from "vitest";
import { resolveInternalRendezvousConfig } from "../rendezvousConfig";

const createLocalStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
};

describe("resolveInternalRendezvousConfig", () => {
  const prevWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = prevWindow;
  });

  it("uses default values when no stored preferences exist", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: createLocalStorage() as unknown as Storage,
    };

    const config = resolveInternalRendezvousConfig();

    expect(config.baseUrl).toBe("https://rendezvous.nkc.im");
    expect(config.useOnionProxy).toBe(false);
  });

  it("uses stored rendezvous preferences when present", () => {
    const localStorage = createLocalStorage();
    localStorage.setItem("rendezvous_base_url_v1", "https://rendezvous.custom");
    localStorage.setItem("rendezvous_use_onion_v1", "true");
    (globalThis as { window?: unknown }).window = {
      localStorage: localStorage as unknown as Storage,
    };

    const config = resolveInternalRendezvousConfig();

    expect(config.baseUrl).toBe("https://rendezvous.custom");
    expect(config.useOnionProxy).toBe(true);
  });
});
