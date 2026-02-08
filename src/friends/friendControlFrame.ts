import { canonicalBytes } from "../crypto/canonicalJson";
import type { UserProfile } from "../db/repo";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";

export type FriendControlFrameType = "friend_req" | "friend_accept" | "friend_decline";

type FriendFrameFrom = {
  identityPub: string;
  dhPub: string;
  deviceId?: string;
  friendCode?: string;
};

type FriendFrameProfile = {
  displayName?: string;
  status?: string;
  avatarRef?: UserProfile["avatarRef"];
};

export type FriendRequestFrame = {
  type: "friend_req";
  convId?: string;
  from: FriendFrameFrom;
  profile?: FriendFrameProfile;
  ts?: number;
  sig?: string;
};

export type FriendResponseFrame = {
  type: "friend_accept" | "friend_decline";
  convId?: string;
  from: FriendFrameFrom;
  profile?: FriendFrameProfile;
  ts?: number;
  sig?: string;
};

export type FriendControlFrame = FriendRequestFrame | FriendResponseFrame;

export type UnsignedFriendControlFrame = Omit<FriendControlFrame, "sig">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

export const isFriendControlFrame = (value: unknown): value is FriendControlFrame => {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (type !== "friend_req" && type !== "friend_accept" && type !== "friend_decline") {
    return false;
  }
  if (!isRecord(value.from)) return false;
  if (typeof value.from.identityPub !== "string" || !value.from.identityPub.trim()) return false;
  if (typeof value.from.dhPub !== "string" || !value.from.dhPub.trim()) return false;
  return true;
};

export const stripFriendControlFrameSignature = (
  frame: FriendControlFrame | UnsignedFriendControlFrame
): UnsignedFriendControlFrame => {
  const { sig, ...unsigned } = frame as FriendControlFrame;
  void sig;
  return unsigned as UnsignedFriendControlFrame;
};

export const signFriendControlFrame = async (
  frame: UnsignedFriendControlFrame,
  identityPriv: Uint8Array
) => {
  const sodium = await getSodium();
  const sig = sodium.crypto_sign_detached(
    canonicalBytes(stripFriendControlFrameSignature(frame)),
    identityPriv
  );
  return encodeBase64Url(sig);
};

export const verifyFriendControlFrameSignature = async (frame: FriendControlFrame) => {
  if (typeof frame.sig !== "string" || !frame.sig.trim()) return false;
  if (typeof frame.from?.identityPub !== "string" || !frame.from.identityPub.trim()) return false;
  try {
    const sodium = await getSodium();
    const sig = decodeBase64Url(frame.sig);
    const verifyKey = decodeBase64Url(frame.from.identityPub);
    const payload = canonicalBytes(stripFriendControlFrameSignature(frame));
    return sodium.crypto_sign_verify_detached(sig, payload, verifyKey);
  } catch {
    return false;
  }
};
