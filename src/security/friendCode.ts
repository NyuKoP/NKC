import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

export type FriendCodeV1 = {
  v: 1;
  displayName?: string;
  identityPub: string;
  dhPub: string;
  routingHints?: { onionAddr?: string; lokinetAddr?: string };
};

const PREFIX = "NKC1-";

const checksumBytes = (bytes: Uint8Array) => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const out = new Uint8Array(4);
  out[0] = (hash >>> 24) & 0xff;
  out[1] = (hash >>> 16) & 0xff;
  out[2] = (hash >>> 8) & 0xff;
  out[3] = hash & 0xff;
  return out;
};

export const encodeFriendCodeV1 = (data: FriendCodeV1) => {
  const payload: FriendCodeV1 = {
    v: 1,
    identityPub: data.identityPub,
    dhPub: data.dhPub,
    displayName: data.displayName,
    routingHints: data.routingHints,
  };
  const payloadBytes = canonicalBytes(payload);
  const checksum = checksumBytes(payloadBytes);
  const combined = new Uint8Array(payloadBytes.length + checksum.length);
  combined.set(payloadBytes, 0);
  combined.set(checksum, payloadBytes.length);
  return `${PREFIX}${encodeBase64Url(combined)}`;
};

export const decodeFriendCodeV1 = (code: string): FriendCodeV1 | { error: string } => {
  const compact = code.trim().replace(/[\s-]/g, "");
  if (!compact.toUpperCase().startsWith(PREFIX.replace("-", ""))) {
    return { error: "친구 코드 형식이 올바르지 않습니다." };
  }
  const raw = compact.slice(PREFIX.length - 1);
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(raw);
  } catch {
    return { error: "친구 코드 디코딩에 실패했습니다." };
  }
  if (decoded.length <= 4) {
    return { error: "친구 코드가 너무 짧습니다." };
  }
  const payloadBytes = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const expected = checksumBytes(payloadBytes);
  for (let i = 0; i < checksum.length; i += 1) {
    if (checksum[i] !== expected[i]) {
      return { error: "친구 코드가 손상되었습니다." };
    }
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as FriendCodeV1;
    if (payload?.v !== 1 || !payload.identityPub || !payload.dhPub) {
      return { error: "친구 코드 데이터가 올바르지 않습니다." };
    }
    return payload;
  } catch {
    return { error: "친구 코드 데이터를 읽을 수 없습니다." };
  }
};
