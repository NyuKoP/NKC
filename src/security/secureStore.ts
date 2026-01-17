export type SecureStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const isNativeRuntime = () => {
  if (typeof window === "undefined") return false;
  const w = window as typeof window & {
    __TAURI__?: unknown;
    electron?: { secureStorage?: unknown };
  };
  return Boolean(w.__TAURI__ || w.electron?.secureStorage);
};

export class BrowserStore implements SecureStore {
  async get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.error("BrowserStore.get failed", error);
      return null;
    }
  }

  async set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      console.error("BrowserStore.set failed", error);
    }
  }

  async remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.error("BrowserStore.remove failed", error);
    }
  }
}

export class NativeStore implements SecureStore {
  private warned = false;

  constructor(private fallback: SecureStore) {}

  private warn() {
    if (this.warned) return;
    this.warned = true;
    console.error("TODO: Wire Tauri/Electron secure storage for native builds.");
  }

  async get(key: string) {
    this.warn();
    return this.fallback.get(key);
  }

  async set(key: string, value: string) {
    this.warn();
    return this.fallback.set(key, value);
  }

  async remove(key: string) {
    this.warn();
    return this.fallback.remove(key);
  }
}

let cachedStore: SecureStore | null = null;

export const getSecureStore = () => {
  if (cachedStore) return cachedStore;
  const browser = new BrowserStore();
  cachedStore = isNativeRuntime() ? new NativeStore(browser) : browser;
  return cachedStore;
};
