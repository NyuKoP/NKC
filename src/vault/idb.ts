const DB_NAME = "vault-db";
const STORE_NAME = "vault";
const ENVELOPE_KEY = "envelope";
const DB_VERSION = 1;

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

request.onerror = () => {
  reject(request.error);
};
  });
};

export const hasEnvelope = async (): Promise<boolean> => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(ENVELOPE_KEY);

    const finalize = () => {
      db.close();
    };

    request.onsuccess = () => {
      resolve(request.result !== undefined);
    };

    request.onerror = () => {
      reject(request.error);
    };

    tx.oncomplete = finalize;
    tx.onerror = () => {
      finalize();
      reject(tx.error);
    };
    tx.onabort = () => {
      finalize();
      reject(tx.error);
    };
  });
};
