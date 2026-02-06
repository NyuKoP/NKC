import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import type { FriendCodeV1 } from "./friendCode";
import { sha256 } from "./sha256";

export type InviteCodeV1 = {
  v: 1;
  friend: FriendCodeV1;
  psk: string;
  exp?: number;
  oneTime?: true;
};

const PREFIX = "NKI1-";
const ZERO_WIDTH_OR_BOM = /[\u200B-\u200D\uFEFF]/g;
const BASE64URL_BODY_ALLOWED = /[^A-Za-z0-9_-]/g;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sanitizeScannedCode = (value: string) => {
  let next = value.replace(ZERO_WIDTH_OR_BOM, "").trim();
  next = next.replace(/^[\s"'`([{<]+/, "");
  next = next.replace(/[\s"'`)\]}>:;,.!?]+$/, "");
  return next;
};

const extractCodeBody = (value: string, prefix: string) => {
  const compact = sanitizeScannedCode(value).replace(/\s+/g, "");
  const prefixCompact = prefix.replace("-", "");
  if (!compact.toUpperCase().startsWith(prefixCompact)) return null;
  let raw = compact.slice(prefixCompact.length);
  raw = raw.replace(/^[-:]/, "");
  raw = raw.replace(BASE64URL_BODY_ALLOWED, "");
  return raw;
};

const hash32Bytes = (bytes: Uint8Array) => {
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

const checksum4Bytes = (payloadBytes: Uint8Array) => sha256(payloadBytes).slice(0, 4);
const legacyChecksum4Bytes = (payloadBytes: Uint8Array) => hash32Bytes(payloadBytes).slice(0, 4);

export const encodeInviteCodeV1 = (data: InviteCodeV1) => {
  const payload: InviteCodeV1 = {
    v: 1,
    friend: data.friend,
    psk: data.psk,
    exp: Number.isFinite(data.exp) ? data.exp : undefined,
    oneTime: data.oneTime ? true : undefined,
  };
  const payloadBytes = canonicalBytes(payload);
  const checksum = checksum4Bytes(payloadBytes);
  const combined = new Uint8Array(payloadBytes.length + checksum.length);
  combined.set(payloadBytes, 0);
  combined.set(checksum, payloadBytes.length);
  return `${PREFIX}${encodeBase64Url(combined)}`;
};

export const decodeInviteCodeV1 = (
  code: string
): InviteCodeV1 | { error: string } => {
  const raw = extractCodeBody(code, PREFIX);
  if (!raw) {
    return { error: "Invalid invite code prefix." };
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(raw);
  } catch {
    return { error: "Invalid invite code encoding." };
  }

  if (decoded.length <= 4) {
    return { error: "Invite code is too short." };
  }

  const payloadBytes = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const expected = checksum4Bytes(payloadBytes);
  const expectedLegacy = legacyChecksum4Bytes(payloadBytes);
  const matches = (candidate: Uint8Array) => {
    if (candidate.length !== checksum.length) return false;
    for (let i = 0; i < checksum.length; i += 1) {
      if (checksum[i] !== candidate[i]) return false;
    }
    return true;
  };
  const checksumOk = matches(expected) || matches(expectedLegacy);
  if (!checksumOk) {
    return { error: "Invite code checksum mismatch." };
  }

  let payload: Partial<InviteCodeV1>;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<InviteCodeV1>;
  } catch {
    return { error: "Invalid invite code payload encoding." };
  }

  if (!payload || payload.v !== 1 || !payload.friend || typeof payload.psk !== "string") {
    return { error: "Invalid invite code payload." };
  }

  if (payload.exp !== undefined) {
    if (!Number.isFinite(payload.exp)) {
      return { error: "Invalid invite code expiry." };
    }
    if (Date.now() > Number(payload.exp)) {
      return { error: "Invite code expired." };
    }
  }

  if (payload.oneTime !== undefined && payload.oneTime !== true) {
    return { error: "Invalid invite code payload." };
  }

  const friend = payload.friend as Partial<FriendCodeV1>;
  if (friend.v !== 1 || typeof friend.identityPub !== "string" || typeof friend.dhPub !== "string") {
    return { error: "Invalid friend payload in invite code." };
  }

  try {
    const pskBytes = decodeBase64Url(payload.psk);
    if (pskBytes.length !== 32) {
      return { error: "Invalid PSK length in invite code." };
    }
  } catch {
    return { error: "Invalid PSK encoding in invite code." };
  }

  try {
    const identityBytes = decodeBase64Url(friend.identityPub);
    const dhBytes = decodeBase64Url(friend.dhPub);
    if (identityBytes.length !== 32 || dhBytes.length !== 32) {
      return { error: "Invalid key lengths in invite code." };
    }
  } catch {
    return { error: "Invalid public keys in invite code." };
  }

  const deviceIdCandidate = typeof friend.deviceId === "string" ? friend.deviceId.trim() : "";
  const deviceId = deviceIdCandidate && UUID_PATTERN.test(deviceIdCandidate)
    ? deviceIdCandidate
    : undefined;

  return {
    v: 1,
    friend: {
      v: 1,
      identityPub: friend.identityPub,
      dhPub: friend.dhPub,
      deviceId,
      onionAddr: typeof friend.onionAddr === "string" ? friend.onionAddr : undefined,
      lokinetAddr: typeof friend.lokinetAddr === "string" ? friend.lokinetAddr : undefined,
    },
    psk: payload.psk,
    exp: payload.exp,
    oneTime: payload.oneTime ? true : undefined,
  };
};
