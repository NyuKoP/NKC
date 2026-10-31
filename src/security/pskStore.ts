import { getSecretStore } from "./secretStore";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import type { ReceiveContext } from "../accounts/receiveContext";

const PSK_PREFIX = "nkc_friend_psk_v1:";

const getSecret = async (key: string, context?: ReceiveContext) => {
  return getSecretStore(context?.owner.session).get(key);
};

const setSecret = async (key: string, value: string, context?: ReceiveContext) => {
  await getSecretStore(context?.owner.session).set(key, value);
};

const removeSecret = async (key: string, context?: ReceiveContext) => {
  await getSecretStore(context?.owner.session).remove(key);
};

export const setFriendPsk = async (friendId: string, psk: Uint8Array, context?: ReceiveContext) => {
  await setSecret(`${PSK_PREFIX}${friendId}`, encodeBase64Url(psk), context);
};

export const getFriendPsk = async (friendId: string, context?: ReceiveContext) => {
  const raw = await getSecret(`${PSK_PREFIX}${friendId}`, context);

  if (raw === null) return null;

  try {
    // Legacy friend-code PSKs may be UTF-8 passphrases, not only 32-byte invite keys.
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("PSK_STATE_INVALID");
    const psk = decodeBase64Url(raw);

    if (!psk.length || encodeBase64Url(psk) !== raw) throw new Error("PSK_STATE_INVALID");

    return psk;
  } catch {
    throw new Error("PSK_STATE_INVALID");
  }
};

export const clearFriendPsk = async (friendId: string, context?: ReceiveContext) => {
  await removeSecret(`${PSK_PREFIX}${friendId}`, context);
};
