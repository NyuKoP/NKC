export type SecretStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type ElectronSecureStorageApi = {
  isAvailable: () => Promise<boolean>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<boolean>;
  remove: (key: string) => Promise<boolean>;
};

const getElectronSecureStorage = (): ElectronSecureStorageApi | null => {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & {
    electron?: { secureStorage?: ElectronSecureStorageApi };
  };
  return w.electron?.secureStorage ?? null;
};

class ElectronSecretStore implements SecretStore {
  private api: ElectronSecureStorageApi;

  constructor(api: ElectronSecureStorageApi) {
    this.api = api;
  }

  async get(key: string) {
    return this.api.get(key);
  }

  async set(key: string, value: string) {
    await this.api.set(key, value);
  }

  async remove(key: string) {
    await this.api.remove(key);
  }
}

let cachedStore: SecretStore | null = null;

export const isSecretStoreAvailable = async () => {
  const api = getElectronSecureStorage();
  if (!api?.isAvailable) return false;
  try {
    return await api.isAvailable();
  } catch {
    return false;
  }
};

export const getSecretStore = () => {
  if (cachedStore) return cachedStore;
  const api = getElectronSecureStorage();
  if (!api) {
    throw new Error("SecretStore unavailable");
  }
  cachedStore = new ElectronSecretStore(api);
  return cachedStore;
};
