import { getSodium } from "../security/sodium";

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

export const normalizeRecoveryKey = (value: string) => {
  const trimmed = value.trim();
  if (!NKC_REGEX.test(trimmed)) {
    throw new Error("Invalid recovery key format.");
  }
  const payload = trimmed.slice(4);
  const bytes = decodeBase64Url(payload);
  if (!bytes || bytes.length !== 32) {
    throw new Error("Invalid recovery key format.");
  }
  return trimmed;
};

export const validateRecoveryKey = (value: string) => {
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
  recoveryKey: string,
  header: VaultHeader
): Promise<Uint8Array> => {
  const sodium = await getSodium();
  const salt = fromB64(sodium, header.salt_b64);
  return sodium.crypto_pwhash(
    32,
    normalizeRecoveryKey(recoveryKey),
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

  const data = parsed as {
    v?: number;
    alg?: string;
    nonce_b64?: unknown;
    ct_b64?: unknown;
    aad?: unknown;
  };

  if (data.v !== 2) {
    throw new Error("Unsupported vault version");
  }
  if (data.alg !== "XCHACHA20POLY1305") {
    throw new Error("Unsupported vault algorithm");
  }
  if (typeof data.nonce_b64 !== "string" || typeof data.ct_b64 !== "string") {
    throw new Error("Invalid vault envelope");
  }

  const aad = data.aad as { schema?: unknown; type?: unknown; id?: unknown };
  if (
    !aad ||
    typeof aad !== "object" ||
    aad.schema !== "NKC" ||
    typeof aad.type !== "string" ||
    typeof aad.id !== "string"
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
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
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

export const encryptJsonRecord = async <T>(
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  data: T
) => {
  const sodium = await getSodium();
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const aad = buildAad(recordType, recordId);
  const aadBytes = buildAadBytes(recordType, recordId);
  const plainBytes = toBytes(JSON.stringify(data));
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainBytes,
    aadBytes,
    null,
    nonce,
    recordKey
  );
  logVaultRecord("encrypt", recordType, recordId, recordKey, nonce, aadBytes, ct);
  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: toB64(sodium, nonce),
    ct_b64: toB64(sodium, ct),
    aad,
  };
  return encodeEnvelope(sodium, envelope);
};

export const decryptJsonRecord = async <T>(
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  enc_b64: string
): Promise<T> => {
  const sodium = await getSodium();
  const { envelope, nonce, ct } = decodeEnvelopeStrict(sodium, enc_b64);
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const aadBytes = buildAadBytes(recordType, recordId);
  if (envelope.aad.type !== recordType || envelope.aad.id !== recordId) {
    throw new Error("AAD mismatch");
  }
  logVaultRecord("decrypt", recordType, recordId, recordKey, nonce, aadBytes, ct);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aadBytes,
    nonce,
    recordKey
  );
  return JSON.parse(fromBytes(plain)) as T;
};

export const chunkBuffer = (buffer: ArrayBuffer, chunkSize: number) => {
  const chunks: Uint8Array[] = [];
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
};

export const encodeBinaryEnvelope = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  bytes: Uint8Array
) => {
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
  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: toB64(sodium, nonce),
    ct_b64: toB64(sodium, ct),
    aad,
  };
  return encodeEnvelope(sodium, envelope);
};

export const decodeBinaryEnvelope = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  enc_b64: string
) => {
  const sodium = await getSodium();
  const { envelope, nonce, ct } = decodeEnvelopeStrict(sodium, enc_b64);
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const aadBytes = buildAadBytes(recordType, recordId);
  if (envelope.aad.type !== recordType || envelope.aad.id !== recordId) {
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
