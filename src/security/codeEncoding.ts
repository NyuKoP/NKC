import { sha256 } from "./sha256";

const ZERO_WIDTH_OR_BOM = /[\u200B-\u200D\uFEFF]/g;

const BASE64_BODY_ALLOWED = /[^A-Za-z0-9_+\-/=]/g;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sanitizeScannedCode = (value: string) => {
  let next = value.replace(ZERO_WIDTH_OR_BOM, "").trim();
  next = next.replace(/^[\s"'`([{<]+/, "");
  next = next.replace(/[\s"'`)\]}>:;,.!?]+$/, "");

  return next;
};

export const extractCodeBody = (value: string, prefix: string) => {
  if (typeof value !== "string" || value.length > 16 * 1024) return null;
  const compact = sanitizeScannedCode(value).replace(/\s+/g, "");
  const prefixCompact = prefix.replace("-", "");

  if (!compact.toUpperCase().startsWith(prefixCompact)) return null;
  let raw = compact.slice(prefixCompact.length);
  raw = raw.replace(/^[-:]/, "");
  raw = raw.replace(BASE64_BODY_ALLOWED, "");

  return raw;
};

export const hash32Bytes = (bytes: Uint8Array) => {
  const seeds = [
    0x811c9dc5, 0x01000193, 0x1234567, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1,
  ];

  const out = new Uint8Array(seeds.length * 4);
  seeds.forEach((seed, idx) => {
    let hash = seed >>> 0;

    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }

    const offset = idx * 4;
    out[offset] = (hash >>> 24) & 0xff;
    out[offset + 1] = (hash >>> 16) & 0xff;
    out[offset + 2] = (hash >>> 8) & 0xff;
    out[offset + 3] = hash & 0xff;
  });

  return out;
};

export const checksum4Bytes = (payloadBytes: Uint8Array) => sha256(payloadBytes).slice(0, 4);

const legacyChecksum4Bytes = (payloadBytes: Uint8Array) => hash32Bytes(payloadBytes).slice(0, 4);

export const hasValidCodeChecksum = (payloadBytes: Uint8Array, checksum: Uint8Array) => {
  const expected = checksum4Bytes(payloadBytes);
  const expectedLegacy = legacyChecksum4Bytes(payloadBytes);

  const matches = (candidate: Uint8Array) => {
    if (candidate.length !== checksum.length) return false;

    for (let i = 0; i < checksum.length; i += 1) {
      if (checksum[i] !== candidate[i]) return false;
    }

    return true;
  };

  return matches(expected) || matches(expectedLegacy);
};
