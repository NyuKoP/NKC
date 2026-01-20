export type PublicStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export class LocalStoragePublicStore implements PublicStore {
  async get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      return;
    }
  }

  async remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      return;
    }
  }
}

let cachedStore: PublicStore | null = null;

export const getPublicStore = () => {
  if (cachedStore) return cachedStore;
  cachedStore = new LocalStoragePublicStore();
  return cachedStore;
};
