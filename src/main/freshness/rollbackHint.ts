import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { canonicalBytes } from "../../crypto/canonicalJson";
import type { DeviceAuthorization } from "../../devices/deviceAuthorization";
import { verifyDeviceCertificate, authorizationIssuersAllowed, MAX_AUTHORITY_ROSTER_BYTES } from "../../devices/deviceAuthorization";

export type RollbackHintState = "CURRENT" | "BOOTSTRAPPED" | "ROLLBACK_SUSPECTED" | "SECURITY_STATE_CONFLICT" | "UNAVAILABLE";
type Entry = { epoch: number; digest: string; revoked: boolean };
type Hint = { v: 1; root: string; devices: Record<string, Entry> };
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const validEntry = (row: Entry) => row && Number.isSafeInteger(row.epoch) && row.epoch > 0 &&
  typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest) && typeof row.revoked === "boolean";

/** Best effort OS-user storage, not a monotonic or independent trust anchor. Profile commits precede hint writes. */
export class RollbackHintStore {
  private pending: Promise<unknown> = Promise.resolve();
  private directory: string;
  private protect: (text: string) => Buffer;
  private unprotect: (bytes: Buffer) => string;
  constructor(directory: string, protect: (text: string) => Buffer, unprotect: (bytes: Buffer) => string) {
    this.directory = directory; this.protect = protect; this.unprotect = unprotect;
  }

  compare(root: string, certificates: DeviceAuthorization[], assertOwner: () => void): Promise<RollbackHintState> {
    const run = this.pending.catch(() => {}).then(() => this.compareSerial(root, certificates, assertOwner));
    this.pending = run;
    return run;
  }

  private async compareSerial(root: string, certificates: DeviceAuthorization[], assertOwner: () => void): Promise<RollbackHintState> {
    assertOwner();
    if (typeof root !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(root) || Buffer.from(root, "base64url").toString("base64url") !== root ||
        !Array.isArray(certificates) || certificates.length < 1 || certificates.length > 32 ||
        new Set(certificates.map(row => row?.deviceId)).size !== certificates.length ||
        Buffer.byteLength(JSON.stringify(certificates)) > MAX_AUTHORITY_ROSTER_BYTES) throw new Error("ROLLBACK_HINT_INPUT_INVALID");
    const profile: Record<string, Entry> = {};
    for (const row of certificates) {
      if (!row || ![2, 3].includes(row.v) || row.accountRootIdentityPub !== root || typeof row.deviceId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(row.deviceId) || !Number.isSafeInteger(row.epoch) || row.epoch < 1 ||
          !["DEVICE_ADDED", "DEVICE_REVOKED"].includes(row.kind) || typeof row.sig !== "string" ||
          !/^[A-Za-z0-9_-]{86}$/.test(row.sig)) throw new Error("ROLLBACK_HINT_INPUT_INVALID");
      if (!await verifyDeviceCertificate(row, root, (payload, sig, publicKey) => verify(null, payload,
        createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" }),
        Buffer.from(sig, "base64url")))) throw new Error("ROLLBACK_HINT_INPUT_INVALID");
      profile[row.deviceId] = { epoch: row.epoch, digest: hash(canonicalBytes(row)), revoked: row.kind === "DEVICE_REVOKED" };
    }
    const registry = Object.fromEntries(certificates.map(certificate => [certificate.deviceId, certificate]));
    if (!(await Promise.all(certificates.map(certificate => authorizationIssuersAllowed(certificate, registry,
      bytes => createHash("sha256").update(bytes).digest("base64url"))))).every(Boolean)) throw new Error("ROLLBACK_HINT_INPUT_INVALID");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error("ROLLBACK_HINT_INVALID");
    const file = path.join(this.directory, hash(root) + ".bin");
    let previous: Hint | undefined;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error("ROLLBACK_HINT_INVALID");
      previous = JSON.parse(this.unprotect(await fs.readFile(file))) as Hint;
      if (previous?.v !== 1 || previous.root !== root || !previous.devices || Array.isArray(previous.devices) ||
          Object.keys(previous.devices).length > 32 || !Object.values(previous.devices).every(validEntry)) throw new Error("ROLLBACK_HINT_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ROLLBACK_HINT_INVALID");
    }
    let state: RollbackHintState = previous ? "CURRENT" : "BOOTSTRAPPED";
    for (const [id, old] of Object.entries(previous?.devices ?? {})) {
      const current = profile[id];
      if (!current || old.epoch > current.epoch) state = "ROLLBACK_SUSPECTED";
      else if (old.epoch === current.epoch && old.digest !== current.digest || old.revoked && !current.revoked) return "SECURITY_STATE_CONFLICT";
    }
    // A lagging hint is the recoverable profile-first crash state. An ahead hint is never lowered.
    if (state === "ROLLBACK_SUSPECTED") return state;
    const next: Hint = { v: 1, root, devices: profile };
    if (JSON.stringify(next) === JSON.stringify(previous)) return state;
    assertOwner();
    const temporary = file + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(this.protect(JSON.stringify(next)));
      await handle.sync();
      await handle.close();
      assertOwner();
      await fs.rename(temporary, file);
      assertOwner();
    } finally {
      await handle.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    return state;
  }
}
