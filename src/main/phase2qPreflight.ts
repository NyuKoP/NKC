import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

type Cipher = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string };

type RecordOnDisk = { v: 1; ciphertext: string; digest: string; cleanExit: boolean };

export type PreflightStatus = "needs_prepare" | "restart_required" | "verified" | "interrupted" | "source_unreadable";

const fileName = "phase2q-preflight.json";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Disposable-only first-use observation gate. No old source is overwritten. */
export const createPhase2QPreflight = (userData: string, cipher: Cipher) => {
  const file = path.join(userData, fileName);
  let preparedHere = false;

  const read = (): RecordOnDisk | null => {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("PREFLIGHT_SOURCE_INVALID");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as RecordOnDisk;

    if (value?.v !== 1 || typeof value.ciphertext !== "string" || !/^[A-Za-z0-9+/=]{1,4096}$/.test(value.ciphertext) ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.cleanExit !== "boolean") {
      throw new Error("PREFLIGHT_SOURCE_INVALID");
    }

    return value;
  };

  const write = (value: RecordOnDisk, exclusive: boolean) => {
    const bytes = JSON.stringify(value);
    const target = exclusive ? file : `${file}.next`;
    const fd = fs.openSync(target, "wx", 0o600);

    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }

    if (!exclusive) fs.renameSync(target, file);
  };

  return {
    status: (): PreflightStatus => {
      let record: RecordOnDisk | null;

      try { record = read(); } catch { return "source_unreadable"; }

      if (!record) return "needs_prepare";

      if (preparedHere) return "restart_required";

      if (!record.cleanExit) return "interrupted";

      try {
        if (!cipher.isEncryptionAvailable() || digest(cipher.decryptString(Buffer.from(record.ciphertext, "base64"))) !== record.digest) {
          return "source_unreadable";
        }
      } catch { return "source_unreadable"; }

      return "verified";
    },
    prepare: (): PreflightStatus => {
      if (read()) throw new Error("PREFLIGHT_SOURCE_EXISTS");

      if (fs.existsSync(path.join(userData, "secret-store.json"))) throw new Error("PREFLIGHT_SECRET_EXISTS");

      if (!cipher.isEncryptionAvailable()) throw new Error("PREFLIGHT_BACKEND_UNAVAILABLE");
      const sample = randomBytes(32).toString("base64url");
      const ciphertext = cipher.encryptString(sample);

      if (cipher.decryptString(ciphertext) !== sample) throw new Error("PREFLIGHT_SAME_PROCESS_FAILED");
      write({ v: 1, ciphertext: ciphertext.toString("base64"), digest: digest(sample), cleanExit: false }, true);
      preparedHere = true;

      return "restart_required";
    },
    markCleanExit: () => {
      if (!preparedHere) return;
      const record = read();

      if (!record || record.cleanExit) throw new Error("PREFLIGHT_SOURCE_INVALID");
      write({ ...record, cleanExit: true }, false);
      preparedHere = false;
    },
  };
};
