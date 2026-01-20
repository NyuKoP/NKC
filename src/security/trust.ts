import { decodeBase64Url, encodeBase64Url } from "./base64url";

const hashChunk = (bytes: Uint8Array, seed: number) => {
  let hash = seed >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const computeFriendId = (identityPubBytes: Uint8Array) => {
  const seeds = [0x811c9dc5, 0x01000193, 0x1234567, 0x9e3779b9];
  const out = new Uint8Array(seeds.length * 4);
  seeds.forEach((seed, idx) => {
    const hash = hashChunk(identityPubBytes, seed);
    const offset = idx * 4;
    out[offset] = (hash >>> 24) & 0xff;
    out[offset + 1] = (hash >>> 16) & 0xff;
    out[offset + 2] = (hash >>> 8) & 0xff;
    out[offset + 3] = hash & 0xff;
  });
  return encodeBase64Url(out).slice(0, 12);
};

type KeyRecord = { identityPub: string; dhPub: string };

export const isKeyChange = (existing: KeyRecord, incoming: KeyRecord) =>
  existing.identityPub !== incoming.identityPub || existing.dhPub !== incoming.dhPub;

export const applyTofu = (
  existing: KeyRecord | null,
  incoming: KeyRecord
): { ok: boolean; status: "trusted" | "blocked"; reason?: string } => {
  if (!existing) {
    return { ok: true, status: "trusted" };
  }
  if (!isKeyChange(existing, incoming)) {
    return { ok: true, status: "trusted" };
  }
  return { ok: false, status: "blocked", reason: "key_changed" };
};

export const decodeIdentityPub = (value: string) => decodeBase64Url(value);
