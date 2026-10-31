import { getSodium } from "../security/sodium";
import { createSafeConsole } from "../diagnostics/safeConsole";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../net/mediaTransferLimits";

const console = createSafeConsole(globalThis.console);

export type VaultHeader = {
  v: 2;
  createdAt: number;
  salt_b64: string;
  opslimit: number;
  memlimit: number;
};

export type Envelope = {
  v: 2;
  alg: "XCHACHA20POLY1305";
  nonce_b64: string;
  ct_b64: string;
  aad: { schema: "NKC"; type: string; id: string };
};

const DOMAIN_VRK = "NKC|VAULTv2|VRK";

const DOMAIN_VK = "NKC|VAULTv2|VK";

const DOMAIN_REC = "NKC|REC";

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

const toB64 = (sodium: Awaited<ReturnType<typeof getSodium>>, bytes: Uint8Array) =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

const fromB64 = (sodium: Awaited<ReturnType<typeof getSodium>>, value: string) =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL);

const toBytes = (value: string) => textEncoder.encode(value);

const fromBytes = (bytes: Uint8Array) => textDecoder.decode(bytes);

const concatBytes = (chunks: Array<Uint8Array | ArrayBuffer>) => {
  const normalized = chunks.map((chunk) =>
    chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  );

  const total = normalized.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of normalized) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
};

const NKC_REGEX = /^NKC-[A-Za-z0-9_-]+$/;

const decodeBase64Url = (value: string) => {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const raw = atob(padded);

    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

export const normalizeStartKey = (value: string) => {
  const trimmed = value.trim();

  if (!NKC_REGEX.test(trimmed)) {
    throw new Error("Invalid start key format.");
  }

  const payload = trimmed.slice(4);
  const bytes = decodeBase64Url(payload);

  if (!bytes || bytes.length !== 32) {
    throw new Error("Invalid start key format.");
  }

  return trimmed;
};

export const validateStartKey = (value: string) => {
  const trimmed = value.trim();

  if (!NKC_REGEX.test(trimmed)) return false;
  const payload = trimmed.slice(4);
  const bytes = decodeBase64Url(payload);

  return Boolean(bytes && bytes.length === 32);
};

export const createVaultHeader = async (): Promise<VaultHeader> => {
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(16);

  return {
    v: 2,
    createdAt: Date.now(),
    salt_b64: toB64(sodium, salt),
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
  };
};

export const deriveMkm = async (
  startKey: string,
  header: VaultHeader
): Promise<Uint8Array> => {
  const sodium = await getSodium();
  const salt = fromB64(sodium, header.salt_b64);

  return sodium.crypto_pwhash(
    32,
    normalizeStartKey(startKey),
    salt,
    header.opslimit,
    header.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
};

export const deriveVrk = async (mkm: Uint8Array) => {
  const sodium = await getSodium();

  return sodium.crypto_generichash(
    32,
    concatBytes([toBytes(DOMAIN_VRK), mkm])
  );
};

export const deriveVk = async (mkm: Uint8Array) => {
  const sodium = await getSodium();

  return sodium.crypto_generichash(
    32,
    concatBytes([toBytes(DOMAIN_VK), mkm])
  );
};

const buildAad = (recordType: string, recordId: string) => ({
  schema: "NKC" as const,
  type: recordType,
  id: recordId,
});

const buildAadBytes = (recordType: string, recordId: string) =>
  toBytes(JSON.stringify(buildAad(recordType, recordId)));

const encodeEnvelope = (
  sodium: Awaited<ReturnType<typeof getSodium>>,
  envelope: Envelope
) => toB64(sodium, toBytes(JSON.stringify(envelope)));

const decodeEnvelopeStrict = (
  sodium: Awaited<ReturnType<typeof getSodium>>,
  enc_b64: string
) => {
  let envelopeBytes: Uint8Array;

  try {
    envelopeBytes = fromB64(sodium, enc_b64);
  } catch {
    throw new Error("Invalid vault envelope encoding");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(fromBytes(envelopeBytes));
  } catch {
    throw new Error("Invalid vault envelope encoding");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid vault envelope");
  }

  const data = parsed;

  if (!("v" in data) || data.v !== 2) {
    throw new Error("Unsupported vault version");
  }

  if (!("alg" in data) || data.alg !== "XCHACHA20POLY1305") {
    throw new Error("Unsupported vault algorithm");
  }

  if (!("nonce_b64" in data) || typeof data.nonce_b64 !== "string" ||
      !("ct_b64" in data) || typeof data.ct_b64 !== "string") {
    throw new Error("Invalid vault envelope");
  }

  const aad = "aad" in data ? data.aad : undefined;

  if (
    !aad ||
    typeof aad !== "object" ||
    !("schema" in aad) || aad.schema !== "NKC" ||
    !("type" in aad) || typeof aad.type !== "string" ||
    !("id" in aad) || typeof aad.id !== "string"
  ) {
    throw new Error("Invalid vault envelope");
  }

  let nonce: Uint8Array;
  let ct: Uint8Array;

  try {
    nonce = fromB64(sodium, data.nonce_b64);
    ct = fromB64(sodium, data.ct_b64);
  } catch {
    throw new Error("Invalid vault envelope encoding");
  }

  if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) {
    throw new Error("Invalid nonce length");
  }

  if (ct.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new Error("Invalid ciphertext length");
  }

  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: data.nonce_b64,
    ct_b64: data.ct_b64,
    aad: { schema: "NKC", type: aad.type, id: aad.id },
  };

  return { envelope, nonce, ct };
};

const shouldLogVaultDebug = (() => {
  try {
    const env = import.meta.env;

    return Boolean(env?.DEV && env.VITE_VAULT_DEBUG === "1");
  } catch {
    return false;
  }
})();

const logVaultRecord = (
  phase: "encrypt" | "decrypt",
  recordType: string,
  recordId: string,
  key: Uint8Array,
  nonce: Uint8Array,
  aadBytes: Uint8Array,
  ct: Uint8Array
) => {
  if (!shouldLogVaultDebug) return;
  console.debug(`[vault:${phase}]`, {
    recordType,
    recordId,
    keyLen: key.length,
    nonceLen: nonce.length,
    aadLen: aadBytes.length,
    ctLen: ct.length,
  });
};

export const deriveRecordKey = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string
) => {
  const sodium = await getSodium();

  return sodium.crypto_generichash(
    32,
    concatBytes([toBytes(DOMAIN_REC), vk, toBytes(recordId), toBytes(recordType)])
  );
};

export function encryptJsonRecord<T>(vk: Uint8Array, recordId: string, recordType: string, data: T): Promise<string>;
export function encryptJsonRecord<T>(vk: Uint8Array, recordId: string, recordType: string, data: T, format: "raw-v3"): Promise<Uint8Array<ArrayBuffer>>;
export function encryptJsonRecord<T>(vk: Uint8Array, recordId: string, recordType: string, data: T,
  format: "raw-v3" | undefined): Promise<string | Uint8Array<ArrayBuffer>>;
export async function encryptJsonRecord<T>(
  vk: Uint8Array, recordId: string, recordType: string, data: T, format?: "raw-v3"
) {
  const bytes = toBytes(JSON.stringify(data));

  return format === undefined ? encodeBinaryEnvelope(vk, recordId, recordType, bytes)
    : encodeBinaryEnvelope(vk, recordId, recordType, bytes, format);
}

export const decryptJsonRecord = async <T>(
  vk: Uint8Array, recordId: string, recordType: string, ciphertext: string | Uint8Array
): Promise<T> => {
  const plain = await decodeBinaryEnvelope(vk, recordId, recordType, ciphertext);

  return JSON.parse(fromBytes(plain)) as T;
};

/** IndexedDB returns independent byte arrays; reference equality is not a ciphertext CAS. */
export const sameStoredCiphertext = (left: string | Uint8Array | undefined, right: string | Uint8Array | undefined) =>
  left instanceof Uint8Array || right instanceof Uint8Array
    ? left instanceof Uint8Array && right instanceof Uint8Array && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    : left === right;

export const chunkBuffer = (buffer: ArrayBuffer, chunkSize: number) => {
  const chunks: Uint8Array[] = [];
  const bytes = new Uint8Array(buffer);

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }

  return chunks;
};

const RAW_VAULT_MAGIC = new Uint8Array([0x4e, 0x4b, 0x43, 0x56, 3]);

const RAW_VAULT_PREFIX_BYTES = 9;

const RAW_VAULT_NONCE_BYTES = 24;

export const MAX_RAW_VAULT_RECORD_BYTES = ONION_TRANSFER_MAX_BODY_BYTES;

const decodeRawVaultRecord = (frame: Uint8Array) => {
  if (frame.length < RAW_VAULT_PREFIX_BYTES + RAW_VAULT_NONCE_BYTES + 16 ||
      frame.length > MAX_RAW_VAULT_RECORD_BYTES || !RAW_VAULT_MAGIC.every((byte, index) => frame[index] === byte)) {
    throw new Error("Invalid raw vault envelope");
  }

  const ciphertextLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(5, false);

  if (RAW_VAULT_PREFIX_BYTES + RAW_VAULT_NONCE_BYTES + ciphertextLength !== frame.length || ciphertextLength < 16) {
    throw new Error("Invalid raw vault envelope length");
  }

  return { nonce: new Uint8Array(frame.subarray(RAW_VAULT_PREFIX_BYTES, RAW_VAULT_PREFIX_BYTES + RAW_VAULT_NONCE_BYTES)),
    ct: new Uint8Array(frame.subarray(RAW_VAULT_PREFIX_BYTES + RAW_VAULT_NONCE_BYTES)) };
};

export function encodeBinaryEnvelope(vk: Uint8Array, recordId: string, recordType: string, bytes: Uint8Array): Promise<string>;
export function encodeBinaryEnvelope(vk: Uint8Array, recordId: string, recordType: string,
  bytes: Uint8Array, format: "raw-v3"): Promise<Uint8Array<ArrayBuffer>>;
export async function encodeBinaryEnvelope(
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  bytes: Uint8Array,
  format?: "raw-v3"
) {
  if (format !== undefined && format !== "raw-v3") throw new Error("Unsupported vault encoding");

  if (format === "raw-v3") {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RAW_VAULT_RECORD_BYTES - RAW_VAULT_PREFIX_BYTES - RAW_VAULT_NONCE_BYTES - 16) {
      throw new Error("Raw vault record too large");
    }

    bytes = new Uint8Array(bytes);
  }

  const sodium = await getSodium();
  const recordKey = await deriveRecordKey(vk, recordId, recordType);

  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );

  const aad = buildAad(recordType, recordId);
  const aadBytes = buildAadBytes(recordType, recordId);

  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes,
    aadBytes,
    null,
    nonce,
    recordKey
  );

  logVaultRecord("encrypt", recordType, recordId, recordKey, nonce, aadBytes, ct);

  if (format === "raw-v3") {
    const frame = new Uint8Array(RAW_VAULT_PREFIX_BYTES + nonce.length + ct.length);
    frame.set(RAW_VAULT_MAGIC);
    new DataView(frame.buffer).setUint32(5, ct.length, false);
    frame.set(nonce, RAW_VAULT_PREFIX_BYTES);
    frame.set(ct, RAW_VAULT_PREFIX_BYTES + nonce.length);

    return frame;
  }

  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: toB64(sodium, nonce),
    ct_b64: toB64(sodium, ct),
    aad,
  };

  return encodeEnvelope(sodium, envelope);
}

export const decodeBinaryEnvelope = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  enc_b64: string | Uint8Array
): Promise<Uint8Array<ArrayBuffer>> => {
  const input = enc_b64 instanceof Uint8Array ? decodeRawVaultRecord(enc_b64) : { legacy: enc_b64 };
  const sodium = await getSodium();
  const parsed = "legacy" in input ? decodeEnvelopeStrict(sodium, input.legacy) : input;
  const { nonce, ct } = parsed;
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const aadBytes = buildAadBytes(recordType, recordId);

  if ("envelope" in parsed && (parsed.envelope.aad.type !== recordType || parsed.envelope.aad.id !== recordId)) {
    throw new Error("AAD mismatch");
  }

  logVaultRecord("decrypt", recordType, recordId, recordKey, nonce, aadBytes, ct);

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aadBytes,
    nonce,
    recordKey
  );
};
