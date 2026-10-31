import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Windows safeStorage can encrypt before Chromium's first Local State write finishes.
export const waitForStorageKeyPersistence = async (sessionData: string, timeoutMs = 15_000) => {
  const file = path.join(sessionData, "Local State");
  const deadline = Date.now() + timeoutMs;

  do {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("STORAGE_KEY_STATE_INVALID");
      const state = JSON.parse(await fs.readFile(file, "utf8"));
      const key = state?.os_crypt?.encrypted_key;
      if (typeof key === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
        const bytes = Buffer.from(key, "base64");
        if (bytes.length > 5 && bytes.subarray(0, 5).toString("ascii") === "DPAPI") return;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) throw new Error("STORAGE_KEY_NOT_PERSISTED");
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error("STORAGE_KEY_NOT_PERSISTED");
};
