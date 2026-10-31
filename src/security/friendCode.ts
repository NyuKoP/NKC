import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { UUID_PATTERN, extractCodeBody, hash32Bytes, checksum4Bytes, hasValidCodeChecksum } from "./codeEncoding";

export type FriendCodeV1 = {
  v: 1;
  identityPub: string;
  dhPub: string;
  deviceId?: string;
  onionAddr?: string;
  inboxWriteToken?: string;
};

const PREFIX = "NKC1-";

export const encodeFriendCodeV1 = (data: FriendCodeV1) => {
  const payload: FriendCodeV1 = {
    v: 1,
    identityPub: data.identityPub,
    dhPub: data.dhPub,
    deviceId: data.deviceId,
    onionAddr: data.onionAddr,
    inboxWriteToken: data.inboxWriteToken,
  };

  const payloadBytes = canonicalBytes(payload);
  const checksum = checksum4Bytes(payloadBytes);
  const combined = new Uint8Array(payloadBytes.length + checksum.length);
  combined.set(payloadBytes, 0);
  combined.set(checksum, payloadBytes.length);

  return `${PREFIX}${encodeBase64Url(combined)}`;
};

export const decodeFriendCodeV1 = (
  code: string
): FriendCodeV1 | { error: string } => {
  const raw = extractCodeBody(code, PREFIX);

  if (!raw) {
    return { error: "Invalid friend code prefix." };
  }

  let decoded: Uint8Array;

  try {
    decoded = decodeBase64Url(raw);
  } catch {
    return { error: "Invalid friend code encoding." };
  }

  if (decoded.length <= 4) {
    return { error: "Friend code is too short." };
  }

  const payloadBytes = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);

  if (!hasValidCodeChecksum(payloadBytes, checksum)) {
    return { error: "Friend code checksum mismatch." };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { error: "Invalid friend code payload encoding." };
  }

  if (!payload || typeof payload !== "object" || !("v" in payload) || payload.v !== 1 ||
      !("identityPub" in payload) || typeof payload.identityPub !== "string" ||
      !("dhPub" in payload) || typeof payload.dhPub !== "string") {
    return { error: "Invalid friend code payload." };
  }

  try {
    const identityBytes = decodeBase64Url(payload.identityPub);
    const dhBytes = decodeBase64Url(payload.dhPub);

    if (identityBytes.length !== 32 || dhBytes.length !== 32) {
      return { error: "Invalid key lengths in friend code." };
    }
  } catch {
    return { error: "Invalid public keys in friend code." };
  }

  const deviceIdCandidate = "deviceId" in payload && typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";

  const deviceId = deviceIdCandidate && UUID_PATTERN.test(deviceIdCandidate)
    ? deviceIdCandidate
    : undefined;

  const inboxWriteToken =
    "inboxWriteToken" in payload && typeof payload.inboxWriteToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(payload.inboxWriteToken)
      ? payload.inboxWriteToken
      : undefined;

  return {
    v: 1,
    identityPub: payload.identityPub,
    dhPub: payload.dhPub,
    deviceId,
    onionAddr: "onionAddr" in payload && typeof payload.onionAddr === "string" ? payload.onionAddr : undefined,
    inboxWriteToken,
  };
};

export const computeFriendId = (identityPubBytes: Uint8Array) =>
  encodeBase64Url(hash32Bytes(identityPubBytes)).slice(0, 16);
