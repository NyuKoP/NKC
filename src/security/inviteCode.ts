import { canonicalBytes } from "../crypto/canonicalJson";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import type { FriendCodeV1 } from "./friendCode";
import { UUID_PATTERN, extractCodeBody, checksum4Bytes, hasValidCodeChecksum } from "./codeEncoding";

export type InviteCodeV1 = {
  v: 1;
  friend: FriendCodeV1;
  psk: string;
  exp?: number;
  oneTime?: true;
};

const PREFIX = "NKI1-";

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

  if (!hasValidCodeChecksum(payloadBytes, checksum)) {
    return { error: "Invite code checksum mismatch." };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { error: "Invalid invite code payload encoding." };
  }

  if (!payload || typeof payload !== "object" || !("v" in payload) || payload.v !== 1 ||
      !("friend" in payload) || !payload.friend || !("psk" in payload) || typeof payload.psk !== "string") {
    return { error: "Invalid invite code payload." };
  }

  const exp = "exp" in payload ? payload.exp : undefined;
  const oneTime = "oneTime" in payload ? payload.oneTime : undefined;

  if (exp !== undefined) {
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      return { error: "Invalid invite code expiry." };
    }

    if (Date.now() > Number(exp)) {
      return { error: "Invite code expired." };
    }
  }

  if (oneTime !== undefined && oneTime !== true) {
    return { error: "Invalid invite code payload." };
  }

  const friend = payload.friend;

  if (typeof friend !== "object" || !("v" in friend) || friend.v !== 1 ||
      !("identityPub" in friend) || typeof friend.identityPub !== "string" ||
      !("dhPub" in friend) || typeof friend.dhPub !== "string") {
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

  const deviceIdCandidate = "deviceId" in friend && typeof friend.deviceId === "string" ? friend.deviceId.trim() : "";

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
      onionAddr: "onionAddr" in friend && typeof friend.onionAddr === "string" ? friend.onionAddr : undefined,
      inboxWriteToken: "inboxWriteToken" in friend && typeof friend.inboxWriteToken === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(friend.inboxWriteToken) ? friend.inboxWriteToken : undefined,
    },
    psk: payload.psk,
    exp,
    oneTime: oneTime ? true : undefined,
  };
};

/** Equal decoded invitations share one local consumption identity, regardless of paste/JSON/base64 spelling. */
export const canonicalInviteCodeV1 = (invite: InviteCodeV1) => encodeInviteCodeV1({
  ...invite,
  friend: {
    ...invite.friend,
    identityPub: encodeBase64Url(decodeBase64Url(invite.friend.identityPub)),
    dhPub: encodeBase64Url(decodeBase64Url(invite.friend.dhPub)),
    // Preserve historical consumption identities, which did not include the mailbox capability.
    inboxWriteToken: undefined,
  },
  psk: encodeBase64Url(decodeBase64Url(invite.psk)),
});
