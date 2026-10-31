import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isAllowedSecretStoreKey } from "./secretStoreKeyPolicy";

const SECRET_STORE_FILENAME = "secret-store.json";

const DELETED_ACCOUNT_PREFIX = "nkc_account_deleted:";

const RATCHET_OWNER_PREFIX = "nkc_ratchet_owner_v1:";

const SESSION_OWNER_PREFIX = "nkc_session_owner_required:";

let pendingWrite: Promise<void> = Promise.resolve();

// shortcut: continuity is RAM-only; strict cold rollback needs an independent latest reference.
const observedRatchets = new Map<string, Map<string, { digest: string; suspected: boolean }>>();

const quarantinedRatchetScopes = new Map<string, Set<string>>();

// A cold restore is indistinguishable from a restart; advance only ratchets created by this Main.
const createdRatchets = new Map<string, Set<string>>();

let nativeRatchetOwnerEnabled = false;

export type NativeRatchetVersion = 1 | 2;

export type NativeRatchetSnapshot = {
  value: string | null;
  revision: number;
  fingerprint: string | null;
};

const fingerprint = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const isRatchetKey = (key: string) => /(?:^|:)nkc_ratchet_v[12]:/.test(key);

const ownerKey = (key: string) => `${RATCHET_OWNER_PREFIX}${key}`;

const checkRatchetContinuity = (data: Record<string, string>, key: string, remember: boolean) => {
  if (!isRatchetKey(key)) return;
  const directory = app.getPath("userData");
  let heads = observedRatchets.get(directory);

  if (!heads) { heads = new Map(); observedRatchets.set(directory, heads); }
  // Fresh SIDs and v1/v2 are alternate ratchets for the same quarantined channel.

  const scope = key.replace(/nkc_ratchet_v[12]:/, "nkc_ratchet:").replace(/:session:[A-Za-z0-9_-]{43}$/, "");

  if (quarantinedRatchetScopes.get(directory)?.has(scope)) throw new Error("ROLLBACK_SUSPECTED");
  const digest = fingerprint(JSON.stringify([data[key] ?? null, data[ownerKey(key)] ?? null]));
  const previous = heads.get(key);

  if (previous?.suspected || previous && previous.digest !== digest) {
    previous.suspected = true;
    let scopes = quarantinedRatchetScopes.get(directory);

    if (!scopes) { scopes = new Set(); quarantinedRatchetScopes.set(directory, scopes); }

    scopes.add(scope);
    throw new Error("ROLLBACK_SUSPECTED");
  }

  if (remember) heads.set(key, { digest, suspected: false });
};

const readSerializedSecret = <T>(read: (data: Record<string, string>) => T, key: string): Promise<T> => {
  const run = pendingWrite.catch(() => undefined).then(async () => {
    const data = await readSecretStore();
    let result: T;

    try { result = read(data); }
    catch (error) {
      if (error instanceof Error && ["OWNER_STATE_INVALID", "SECRET_STORE_DECRYPT_FAILED"].includes(error.message))
        checkRatchetContinuity(data, key, false);
      throw error;
    }

    checkRatchetContinuity(data, key, true);

    return result;
  });

  pendingWrite = run.then(() => undefined, () => undefined);

  return run;
};

const validRatchetPayload = (value: string, version: NativeRatchetVersion) => {
  let state: Record<string, unknown>;

  try { state = JSON.parse(value) as Record<string, unknown>; }
  catch { return false; }

  if (!state || typeof state !== "object" || Array.isArray(state)) return false;

  const key = (name: string) => {
    const encoded = state[name];

    return typeof encoded === "string" && /^[A-Za-z0-9_-]{43}$/.test(encoded) &&
      Buffer.from(encoded, "base64url").length === 32 && Buffer.from(encoded, "base64url").toString("base64url") === encoded;
  };

  const counter = (name: string) => {
    const value = state[name];

    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  };

  if (version === 1) return key("ck") && counter("sendI") && counter("recvI");

  return state.v === 2 && key("rk") && key("dhSelfPriv") && key("dhSelfPub") &&
    (state.dhRemotePub === null || state.dhRemotePub === undefined || key("dhRemotePub")) &&
    key("sendCk") && key("recvCk") && counter("sendI") && counter("recvI") &&
    (state.pn === undefined || counter("pn")) && (state.mode === "sym" || state.mode === "dh");
};

const ratchetKey = (accountId: string, channel: string, version: NativeRatchetVersion) => {
  if (accountId !== "legacy" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error("OWNER_ACCOUNT_INVALID");
  }

  if (typeof channel !== "string" || !channel || channel.length > 200 ||
      Array.from(channel).some((character) => character.charCodeAt(0) < 32) ||
      (version !== 1 && version !== 2)) throw new Error("OWNER_CHANNEL_INVALID");
  const inner = `nkc_ratchet_v${version}:${channel}`;
  const key = accountId === "legacy" ? inner : `nkc_account:${accountId.toLowerCase()}:${inner}`;

  if (!isAllowedSecretStoreKey(key)) throw new Error("OWNER_CHANNEL_INVALID");

  return key;
};

const decryptEntry = (entry: string) => {
  if (!entry) throw new Error("SECRET_STORE_DECRYPT_FAILED");

  try { return safeStorage.decryptString(Buffer.from(entry, "base64")); }
  catch { throw new Error("SECRET_STORE_DECRYPT_FAILED"); }
};

const readRatchetFromPayload = (data: Record<string, string>, key: string): NativeRatchetSnapshot => {
  if (data[`${SESSION_OWNER_PREFIX}${key}`] !== undefined) throw new Error("OWNER_REQUIRED");
  const entry = data[key];
  const metadata = data[ownerKey(key)];

  if (entry === undefined && metadata === undefined) return { value: null, revision: 0, fingerprint: null };

  if (metadata === undefined) throw new Error("UNOWNED_LEGACY_STATE");
  let owner: unknown;

  try { owner = JSON.parse(decryptEntry(metadata)); }
  catch { throw new Error("OWNER_STATE_INVALID"); }

  if (!owner || typeof owner !== "object" || !("v" in owner) || owner.v !== 1 ||
      !("revision" in owner) || typeof owner.revision !== "number" || !Number.isSafeInteger(owner.revision) || owner.revision < 1 ||
      entry === undefined) throw new Error("OWNER_STATE_INVALID");
  const value = decryptEntry(entry);

  if (!("fingerprint" in owner) || owner.fingerprint !== fingerprint(value)) throw new Error("OWNER_STATE_INVALID");

  return { value, revision: owner.revision, fingerprint: owner.fingerprint };
};

/** Enabled only after a fresh disposable profile has passed its Main startup guard. */
export const configureNativeRatchetOwner = (enabled: boolean) => { nativeRatchetOwnerEnabled = enabled; };

export const readNativeRatchetSnapshot = async (
  accountId: string, channel: string, version: NativeRatchetVersion,
): Promise<NativeRatchetSnapshot> => {
  if (!nativeRatchetOwnerEnabled) throw new Error("OWNER_REQUIRED");

  if (!isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");
  const key = ratchetKey(accountId, channel, version);

  return readSerializedSecret(data => {
    if (accountDeleted(data, accountId)) throw new Error("SECRET_STORE_ACCOUNT_DELETED");

    return readRatchetFromPayload(data, key);
  }, key);
};

export const commitNativeRatchetState = async (request: {
  accountId: string; channel: string; version: NativeRatchetVersion;
  expectedRevision: number; expectedFingerprint: string | null; nextValue: string;
}): Promise<NativeRatchetSnapshot> => {
  if (!nativeRatchetOwnerEnabled) throw new Error("OWNER_REQUIRED");

  if (!isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");
  const { accountId, channel, version, expectedRevision, expectedFingerprint, nextValue } = request;
  const key = ratchetKey(accountId, channel, version);

  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      (expectedFingerprint !== null && !/^[0-9a-f]{64}$/.test(expectedFingerprint)) ||
      typeof nextValue !== "string" || !nextValue || nextValue.length > 4096) throw new Error("OWNER_REQUEST_INVALID");

  if (!validRatchetPayload(nextValue, version)) throw new Error("RATCHET_STATE_INVALID");
  const nextFingerprint = fingerprint(nextValue);
  const encrypted = safeStorage.encryptString(nextValue).toString("base64");
  let result!: NativeRatchetSnapshot;
  await updateSecretStore((data) => {
    if (accountDeleted(data, accountId)) {
      throw new Error("SECRET_STORE_ACCOUNT_DELETED");
    }

    const current = readRatchetFromPayload(data, key);

    if (current.revision !== expectedRevision) throw new Error("STALE_OWNER_REVISION");

    if (current.fingerprint !== expectedFingerprint) throw new Error("PRIOR_STATE_MISMATCH");

    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("OWNER_REVISION_EXHAUSTED");
    const revision = current.revision + 1;
    data[key] = encrypted;
    data[ownerKey(key)] = safeStorage.encryptString(JSON.stringify({ v: 1, revision, fingerprint: nextFingerprint })).toString("base64");
    result = { value: nextValue, revision, fingerprint: nextFingerprint };
  }, undefined, key);

  return result;
};

const scopedAccountId = (key: string) =>
  /^nkc_account:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i.exec(key)?.[1].toLowerCase();

const accountDeleted = (data: Record<string, string>, accountId: string) =>
  data[`${DELETED_ACCOUNT_PREFIX}${accountId.toLowerCase()}`] !== undefined;

const isSecureStorageBackendAvailable = () => {
  if (!safeStorage.isEncryptionAvailable()) return false;

  if (process.platform !== "linux") return true;

  return safeStorage.getSelectedStorageBackend() !== "basic_text";
};

const readSecretStore = async () => {
  const filePath = path.join(app.getPath("userData"), SECRET_STORE_FILENAME);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")) {
      throw new Error("SECRET_STORE_INVALID");
    }

    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = String(error.code ?? "");

      if (code === "ENOENT") return {};
    }

    throw new Error("SECRET_STORE_READ_FAILED");
  }
};

const updateSecretStore = async (
  update: (payload: Record<string, string>) => boolean | void,
  assertCurrent?: () => void,
  ratchet?: string,
) => {
  const filePath = path.join(app.getPath("userData"), SECRET_STORE_FILENAME);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  const write = pendingWrite.catch(() => undefined).then(async () => {
    const payload = await readSecretStore();
    assertCurrent?.();

    if (ratchet) checkRatchetContinuity(payload, ratchet, false);

    const previous = ratchet && isRatchetKey(ratchet) ? payload[ratchet] : undefined;

    if (update(payload) === false) return;

    if (ratchet && previous !== undefined &&
        !createdRatchets.get(app.getPath("userData"))?.has(ratchet)) {
      if (payload[ratchet] === undefined) throw new Error("RATCHET_PRIOR_PROCESS");
      const before = JSON.parse(decryptEntry(previous));
      const after = JSON.parse(decryptEntry(payload[ratchet]));
      const pending: unknown = before.pendingReceiveCommits;
      const remaining: unknown = after.pendingReceiveCommits ?? [];
      delete before.pendingReceiveCommits;
      delete after.pendingReceiveCommits;
      // Crash recovery may retire one existing commit marker, never advance restored key material.
      if (!Array.isArray(pending) || !Array.isArray(remaining) || remaining.length !== pending.length - 1 ||
          pending.some(item => typeof item !== "string") || new Set(pending).size !== pending.length ||
          JSON.stringify(remaining) !== JSON.stringify(pending.filter(value => remaining.includes(value))) ||
          !isDeepStrictEqual(before, after)) throw new Error("RATCHET_PRIOR_PROCESS");
    }

    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload), {
        encoding: "utf8",
        mode: 0o600,
        flush: true,
      });

      for (let attempt = 0; ; attempt++) {
        assertCurrent?.();

        try {
          await fs.rename(temporaryPath, filePath);
          break;
        } catch (error) {
          // Windows sharing/access locks can briefly deny replacement; never delete the destination.
          const code = (error as NodeJS.ErrnoException)?.code;

          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 4) throw error;
          await delay(50 * (attempt + 1));
        }
      }
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    await fs.chmod(filePath, 0o600).catch(() => undefined);

    if (ratchet) {
      if (isRatchetKey(ratchet) && previous === undefined && payload[ratchet] !== undefined) {
        const directory = app.getPath("userData");
        let keys = createdRatchets.get(directory);

        if (!keys) { keys = new Set(); createdRatchets.set(directory, keys); }
        keys.add(ratchet);
      }
      const heads = observedRatchets.get(app.getPath("userData"));
      heads?.delete(ratchet);
      checkRatchetContinuity(payload, ratchet, true);
    }
  });

  pendingWrite = write;
  await write;
};

export const saveKeyPair = async (key: string, value: string) => {
  if (!isAllowedSecretStoreKey(key) || typeof value !== "string") return false;

  if (!isSecureStorageBackendAvailable()) return false;
  const encrypted = safeStorage.encryptString(value).toString("base64");
  await updateSecretStore((data) => {
    const accountId = scopedAccountId(key);

    if (data[`${SESSION_OWNER_PREFIX}${key}`] !== undefined) throw new Error("OWNER_REQUIRED");

    if (accountId && data[`${DELETED_ACCOUNT_PREFIX}${accountId}`]) throw new Error("SECRET_STORE_ACCOUNT_DELETED");

    if (!accountId && accountDeleted(data, "legacy")) {
      throw new Error("SECRET_STORE_ACCOUNT_DELETED");
    }

    if (isRatchetKey(key) && (nativeRatchetOwnerEnabled || data[ownerKey(key)] !== undefined)) throw new Error("OWNER_REQUIRED");
    data[key] = encrypted;
  }, undefined, key);

  return true;
};

export const loadKeyPair = async (key: string) => {
  if (!isAllowedSecretStoreKey(key)) return null;

  if (!isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");

  return readSerializedSecret(data => {
    if (data[`${SESSION_OWNER_PREFIX}${key}`] !== undefined) throw new Error("OWNER_REQUIRED");

    return data[key] === undefined ? null : decryptEntry(data[key]);
  }, key);
};

export const removeKeyPair = async (key: string) => {
  if (!isAllowedSecretStoreKey(key)) return false;

  if (!isSecureStorageBackendAvailable()) return false;
  await updateSecretStore((data) => {
    if (data[`${SESSION_OWNER_PREFIX}${key}`] !== undefined) throw new Error("OWNER_REQUIRED");

    if (isRatchetKey(key) && (nativeRatchetOwnerEnabled || data[ownerKey(key)] !== undefined)) throw new Error("OWNER_REQUIRED");

    if (!(key in data)) return false;
    delete data[key];
  }, undefined, key);

  return true;
};

export const removeAccountSecrets = async (accountId: string, owner?: SessionSecretOwner) => {
  if (!isSecureStorageBackendAvailable()) return false;
  const scopedPrefix = `nkc_account:${accountId.toLowerCase()}:`;
  const isLegacy = accountId === "legacy";

  if (!isLegacy && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    return false;
  }

  await updateSecretStore((data) => {
    let changed = false;

    const sessionOwnedLegacy = isLegacy && Object.keys(data).some(key =>
      key.startsWith(SESSION_OWNER_PREFIX) && !key.slice(SESSION_OWNER_PREFIX.length).startsWith("nkc_account:"));

    const sessionOwned = sessionOwnedLegacy || Object.keys(data).some(key => key.toLowerCase().startsWith(`${SESSION_OWNER_PREFIX}${scopedPrefix}`));

    if (sessionOwned) {
      if (!owner) throw new Error("OWNER_REQUIRED");
      owner.assertCurrent();

      if (owner.accountId !== accountId.toLowerCase()) throw new Error("OWNER_ACCOUNT_MISMATCH");
    }

    for (const key of Object.keys(data)) {
      const belongsToAccount = isLegacy
        ? (!key.startsWith("nkc_account:") && isAllowedSecretStoreKey(key)) ||
          (key.startsWith(RATCHET_OWNER_PREFIX) && !key.slice(RATCHET_OWNER_PREFIX.length).startsWith("nkc_account:")) ||
          (key.startsWith(SESSION_OWNER_PREFIX) && !key.slice(SESSION_OWNER_PREFIX.length).startsWith("nkc_account:"))
        : key.toLowerCase().startsWith(scopedPrefix) ||
          key.toLowerCase().startsWith(`${RATCHET_OWNER_PREFIX}${scopedPrefix}`) ||
          key.toLowerCase().startsWith(`${SESSION_OWNER_PREFIX}${scopedPrefix}`);

      if (belongsToAccount) {
        delete data[key];
        changed = true;
      }
    }

    if (!isLegacy || nativeRatchetOwnerEnabled || sessionOwnedLegacy) {
      // A delayed generic IPC write must not recreate a deleted account secret.
      data[`${DELETED_ACCOUNT_PREFIX}${accountId.toLowerCase()}`] = "1";
      changed = true;
    }

    return changed;
  }, owner?.assertCurrent);

  const heads = observedRatchets.get(app.getPath("userData"));

  const created = createdRatchets.get(app.getPath("userData"));

  for (const key of created ?? []) {
    if ((scopedAccountId(key) ?? "legacy") === accountId.toLowerCase()) created!.delete(key);
  }

  for (const key of heads?.keys() ?? []) {
    if ((scopedAccountId(key) ?? "legacy") === accountId.toLowerCase()) heads!.delete(key);
  }

  const scopes = quarantinedRatchetScopes.get(app.getPath("userData"));

  for (const key of scopes ?? []) {
    if ((scopedAccountId(key) ?? "legacy") === accountId.toLowerCase()) scopes!.delete(key);
  }

  return true;
};

export const isSecretStoreAvailable = () => isSecureStorageBackendAvailable();

/** Evidence, not a second registry or proof of a renderer's vault credentials. */
export const getAccountSessionEvidence = async (accountId: string) => {
  await pendingWrite.catch(() => undefined);
  const data = await readSecretStore();

  if (accountDeleted(data, accountId)) throw new Error("SECRET_STORE_ACCOUNT_DELETED");
  const prefix = `nkc_account:${accountId}:`;

  return Object.keys(data).some(key => accountId === "legacy"
    ? !key.startsWith("nkc_account:") && isAllowedSecretStoreKey(key) : key.startsWith(prefix))
    ? "existing-secret-namespace" : "trusted-renderer-announcement";
};

export type SessionSecretOwner = { accountId: string; assertCurrent: () => void };

const assertSessionSecretOwner = (data: Record<string, string>, key: string, owner: SessionSecretOwner) => {
  owner.assertCurrent();

  if (!isAllowedSecretStoreKey(key)) throw new Error("OWNER_KEY_INVALID");

  if ((scopedAccountId(key) ?? "legacy") !== owner.accountId) throw new Error("OWNER_ACCOUNT_MISMATCH");

  if (accountDeleted(data, owner.accountId)) throw new Error("SECRET_STORE_ACCOUNT_DELETED");
};

export const loadSessionOwnedSecret = async (key: string, owner: SessionSecretOwner) => {
  if (!isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");

  return readSerializedSecret(data => {
    assertSessionSecretOwner(data, key, owner);

    return data[key] === undefined ? null : decryptEntry(data[key]);
  }, key);
};

export const saveSessionOwnedSecret = async (key: string, value: string, owner: SessionSecretOwner,
  expected?: { value: string | null }) => {
  if (typeof value !== "string" || !isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");

  if (expected !== undefined && (!expected || typeof expected !== "object" ||
      !(expected.value === null || typeof expected.value === "string"))) throw new Error("OWNER_EXPECTATION_INVALID");
  owner.assertCurrent();
  const encrypted = safeStorage.encryptString(value).toString("base64");
  await updateSecretStore(data => {
    assertSessionSecretOwner(data, key, owner);

    // Native CAS remains a separate opt-in; do not bypass its owner metadata.
    if (isRatchetKey(key) && (nativeRatchetOwnerEnabled || data[ownerKey(key)] !== undefined)) throw new Error("OWNER_REQUIRED");

    if (expected && (data[key] === undefined ? null : decryptEntry(data[key])) !== expected.value) throw new Error("PRIOR_STATE_MISMATCH");
    data[`${SESSION_OWNER_PREFIX}${key}`] = "1";
    data[key] = encrypted;
  }, owner.assertCurrent, key);

  return true;
};

export const removeSessionOwnedSecret = async (key: string, owner: SessionSecretOwner) => {
  if (!isSecureStorageBackendAvailable()) throw new Error("SECRET_STORE_UNAVAILABLE");
  await updateSecretStore(data => {
    assertSessionSecretOwner(data, key, owner);

    if (isRatchetKey(key) && (nativeRatchetOwnerEnabled || data[ownerKey(key)] !== undefined)) throw new Error("OWNER_REQUIRED");
    data[`${SESSION_OWNER_PREFIX}${key}`] = "1"; // Removal must not reopen generic access.
    delete data[key];
  }, owner.assertCurrent, key);

  return true;
};
