type SodiumModule = typeof import("libsodium-wrappers-sumo");

let sodiumInstance: SodiumModule | null = null;

const ready = { promise: null as Promise<void> | null };

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

export const initSodium = async () => {
  if (!sodiumInstance) {
    const mod = (await import("libsodium-wrappers-sumo")) as SodiumModule;
    sodiumInstance = (mod as unknown as { default?: SodiumModule }).default ?? mod;
  }
  if (!ready.promise) {
    ready.promise = sodiumInstance.ready;
  }
  await ready.promise;
  return sodiumInstance;
};

const toB64 = (bytes: Uint8Array) =>
  sodiumInstance!.to_base64(bytes, sodiumInstance!.base64_variants.ORIGINAL);

const fromB64 = (value: string) =>
  sodiumInstance!.from_base64(value, sodiumInstance!.base64_variants.ORIGINAL);

const toBytes = (value: string) => sodiumInstance!.from_string(value);

const concatBytes = (chunks: Uint8Array[]) => sodiumInstance!.concat(chunks);

export const generateRecoveryKey = async () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(24);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }
  globalThis.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]);
  return `NKC-${chars.slice(0, 4).join("")}-${chars
    .slice(4, 8)
    .join("")}-${chars.slice(8, 12).join("")}-${chars
    .slice(12, 16)
    .join("")}`;
};

export const normalizeRecoveryKey = (value: string) =>
  value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

export const validateRecoveryKey = (value: string) => {
  const normalized = normalizeRecoveryKey(value);
  return normalized.startsWith("NKC") && normalized.length === 19;
};

export const createVaultHeader = async (): Promise<VaultHeader> => {
  await initSodium();
  const salt = sodiumInstance!.randombytes_buf(16);
  return {
    v: 2,
    createdAt: Date.now(),
    salt_b64: toB64(salt),
    opslimit: sodiumInstance!.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodiumInstance!.crypto_pwhash_MEMLIMIT_MODERATE,
  };
};

export const deriveMkm = async (
  recoveryKey: string,
  header: VaultHeader
): Promise<Uint8Array> => {
  await initSodium();
  const salt = fromB64(header.salt_b64);
  return sodiumInstance!.crypto_pwhash(
    32,
    normalizeRecoveryKey(recoveryKey),
    salt,
    header.opslimit,
    header.memlimit,
    sodiumInstance!.crypto_pwhash_ALG_ARGON2ID13
  );
};

export const deriveVrk = async (mkm: Uint8Array) => {
  await initSodium();
  return sodiumInstance!.crypto_generichash(32, concatBytes([toBytes(DOMAIN_VRK), mkm]));
};

export const deriveVk = async (mkm: Uint8Array) => {
  await initSodium();
  return sodiumInstance!.crypto_generichash(32, concatBytes([toBytes(DOMAIN_VK), mkm]));
};

export const deriveRecordKey = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string
) => {
  await initSodium();
  return sodiumInstance!.crypto_generichash(
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
  await initSodium();
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const nonce = sodiumInstance!.randombytes_buf(
    sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const aad = { schema: "NKC" as const, type: recordType, id: recordId };
  const aadBytes = toBytes(JSON.stringify(aad));
  const plainBytes = toBytes(JSON.stringify(data));
  const ct = sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainBytes,
    aadBytes,
    null,
    nonce,
    recordKey
  );
  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: toB64(nonce),
    ct_b64: toB64(ct),
    aad,
  };
  return toB64(toBytes(JSON.stringify(envelope)));
};

export const decryptJsonRecord = async <T>(
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  enc_b64: string
): Promise<T> => {
  await initSodium();
  const envelopeBytes = fromB64(enc_b64);
  const envelope = JSON.parse(sodiumInstance!.to_string(envelopeBytes)) as Envelope;
  if (envelope.v !== 2) throw new Error("Unsupported vault version");
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const nonce = fromB64(envelope.nonce_b64);
  const ct = fromB64(envelope.ct_b64);
  const aadBytes = toBytes(JSON.stringify(envelope.aad));
  const plain = sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aadBytes,
    nonce,
    recordKey
  );
  return JSON.parse(sodiumInstance!.to_string(plain)) as T;
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
  await initSodium();
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const nonce = sodiumInstance!.randombytes_buf(
    sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const aad = { schema: "NKC" as const, type: recordType, id: recordId };
  const aadBytes = toBytes(JSON.stringify(aad));
  const ct = sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes,
    aadBytes,
    null,
    nonce,
    recordKey
  );
  const envelope: Envelope = {
    v: 2,
    alg: "XCHACHA20POLY1305",
    nonce_b64: toB64(nonce),
    ct_b64: toB64(ct),
    aad,
  };
  return toB64(toBytes(JSON.stringify(envelope)));
};

export const decodeBinaryEnvelope = async (
  vk: Uint8Array,
  recordId: string,
  recordType: string,
  enc_b64: string
) => {
  await initSodium();
  const envelopeBytes = fromB64(enc_b64);
  const envelope = JSON.parse(sodiumInstance!.to_string(envelopeBytes)) as Envelope;
  const recordKey = await deriveRecordKey(vk, recordId, recordType);
  const nonce = fromB64(envelope.nonce_b64);
  const ct = fromB64(envelope.ct_b64);
  const aadBytes = toBytes(JSON.stringify(envelope.aad));
  return sodiumInstance!.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aadBytes,
    nonce,
    recordKey
  );
};
