import { getSecureStore } from "./secureStore";
import { getVaultKey } from "../crypto/sessionKeyring";
import { getSodium } from "./sodium";

type PinRecord = {
  v: 1;
  salt_b64: string;
  hash_b64: string;
  opslimit: number;
  memlimit: number;
  nonce_b64: string;
  sealedVk_b64: string;
  failures: number;
  lockedUntil: number;
  updatedAt: number;
};

export type PinVerifyResult =
  | { ok: true; vaultKey: Uint8Array }
  | { ok: false; reason: "not_set" | "locked" | "mismatch"; retryAfterMs?: number };

const PIN_RECORD_KEY = "nkc_pin_v1";
const PIN_RESET_KEY = "nkc_pin_reset_v1";
const MAX_BACKOFF_MS = 30_000;

const normalizePin = (pin: string) => pin.trim();

const isPinValid = (pin: string) => /^\d{4,8}$/.test(pin);

const readPinRecord = async () => {
  const store = getSecureStore();
  const raw = await store.get(PIN_RECORD_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as PinRecord;
    if (record.v !== 1) return null;
    return record;
  } catch (error) {
    console.error("Failed to read PIN record", error);
    await store.remove(PIN_RECORD_KEY);
    return null;
  }
};

const writePinRecord = async (record: PinRecord) => {
  const store = getSecureStore();
  await store.set(PIN_RECORD_KEY, JSON.stringify(record));
};

const setPinNeedsReset = async (needsReset: boolean) => {
  const store = getSecureStore();
  if (!needsReset) {
    await store.remove(PIN_RESET_KEY);
    return;
  }
  await store.set(
    PIN_RESET_KEY,
    JSON.stringify({ needsReset: true, updatedAt: Date.now() })
  );
};

const getPinNeedsReset = async () => {
  const store = getSecureStore();
  const raw = await store.get(PIN_RESET_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { needsReset?: boolean };
    return Boolean(parsed.needsReset);
  } catch (error) {
    console.error("Failed to read PIN reset flag", error);
    await store.remove(PIN_RESET_KEY);
    return false;
  }
};

const resetFailures = (record: PinRecord) => ({
  ...record,
  failures: 0,
  lockedUntil: 0,
  updatedAt: Date.now(),
});

const bumpFailures = (record: PinRecord) => {
  const failures = (record.failures || 0) + 1;
  const exp = Math.min(5, failures - 1);
  const backoffMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** exp);
  return {
    ...record,
    failures,
    lockedUntil: Date.now() + backoffMs,
    updatedAt: Date.now(),
  };
};

export const getPinStatus = async () => {
  const record = await readPinRecord();
  const needsReset = await getPinNeedsReset();
  return {
    enabled: Boolean(record) || needsReset,
    needsReset,
    lockedUntil: record?.lockedUntil ?? 0,
    failures: record?.failures ?? 0,
  };
};

export const setPin = async (pin: string) => {
  const normalized = normalizePin(pin);
  if (!isPinValid(normalized)) {
    throw new Error("PIN은 4-8자리 숫자여야 합니다.");
  }
  const vk = getVaultKey();
  if (!vk) {
    throw new Error("금고 키를 사용할 수 없습니다.");
  }
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(16);
  const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  const pinKey = sodium.crypto_pwhash(
    32,
    normalized,
    salt,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const sealed = sodium.crypto_secretbox_easy(vk, nonce, pinKey);
  const record: PinRecord = {
    v: 1,
    salt_b64: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
    hash_b64: sodium.to_base64(pinKey, sodium.base64_variants.ORIGINAL),
    opslimit,
    memlimit,
    nonce_b64: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    sealedVk_b64: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
    failures: 0,
    lockedUntil: 0,
    updatedAt: Date.now(),
  };
  await writePinRecord(record);
  await setPinNeedsReset(false);
};

export const verifyPin = async (pin: string): Promise<PinVerifyResult> => {
  const record = await readPinRecord();
  if (!record) {
    if (await getPinNeedsReset()) {
      return { ok: false, reason: "not_set" };
    }
    return { ok: false, reason: "not_set" };
  }
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return {
      ok: false,
      reason: "locked",
      retryAfterMs: record.lockedUntil - Date.now(),
    };
  }
  const normalized = normalizePin(pin);
  if (!isPinValid(normalized)) {
    const next = bumpFailures(record);
    await writePinRecord(next);
    return {
      ok: false,
      reason: "mismatch",
      retryAfterMs: next.lockedUntil - Date.now(),
    };
  }
  const sodium = await getSodium();
  const salt = sodium.from_base64(record.salt_b64, sodium.base64_variants.ORIGINAL);
  const expectedHash = sodium.from_base64(
    record.hash_b64,
    sodium.base64_variants.ORIGINAL
  );
  const pinKey = sodium.crypto_pwhash(
    32,
    normalized,
    salt,
    record.opslimit,
    record.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const matches = sodium.memcmp(pinKey, expectedHash);
  if (!matches) {
    const next = bumpFailures(record);
    await writePinRecord(next);
    return {
      ok: false,
      reason: "mismatch",
      retryAfterMs: next.lockedUntil - Date.now(),
    };
  }
  const nonce = sodium.from_base64(
    record.nonce_b64,
    sodium.base64_variants.ORIGINAL
  );
  const sealed = sodium.from_base64(
    record.sealedVk_b64,
    sodium.base64_variants.ORIGINAL
  );
  const vk = sodium.crypto_secretbox_open_easy(sealed, nonce, pinKey);
  await writePinRecord(resetFailures(record));
  return { ok: true, vaultKey: new Uint8Array(vk) };
};

export const clearPin = async () => {
  const store = getSecureStore();
  await store.remove(PIN_RECORD_KEY);
  await setPinNeedsReset(false);
};

export const clearPinRecord = async () => {
  const store = getSecureStore();
  await store.remove(PIN_RECORD_KEY);
  await setPinNeedsReset(true);
};
