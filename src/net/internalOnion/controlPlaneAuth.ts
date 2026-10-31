import { canonicalBytes } from "../../crypto/canonicalJson";
import { useAppStore } from "../../app/store";
import { decodeBase64Url, encodeBase64Url } from "../../security/base64url";
import { getIdentityPrivateKey } from "../../security/identityKeys";
import { getSodium } from "../../security/sodium";
import type { ReceiveContext } from "../../accounts/receiveContext";
import { listProfiles } from "../../db/repo";
import type { InternalOnionControlPlaneMessage } from "./types";

const CONTROL_PLANE_SIGNATURE_DOMAIN = "nkc-internal-onion-control-v1";

const toUnsignedMessage = (message: InternalOnionControlPlaneMessage) => {
  const unsigned: InternalOnionControlPlaneMessage = { ...message };
  delete unsigned.sig;

  return unsigned;
};

export const getControlPlaneSigningBytes = (message: InternalOnionControlPlaneMessage) =>
  canonicalBytes({
    domain: CONTROL_PLANE_SIGNATURE_DOMAIN,
    message: toUnsignedMessage(message),
  });

export const signControlPlaneMessageWithKey = async <
  T extends InternalOnionControlPlaneMessage,
>(
  message: T,
  privateKey: Uint8Array
): Promise<T> => {
  const sodium = await getSodium();

  const sig = encodeBase64Url(
    sodium.crypto_sign_detached(getControlPlaneSigningBytes(message), privateKey)
  );

  return { ...message, sig };
};

export const verifyControlPlaneMessageWithKey = async (
  message: InternalOnionControlPlaneMessage,
  publicKey: Uint8Array
) => {
  if (!message.sig) return false;

  try {
    const sodium = await getSodium();

    return sodium.crypto_sign_verify_detached(
      decodeBase64Url(message.sig),
      getControlPlaneSigningBytes(message),
      publicKey
    );
  } catch {
    return false;
  }
};

export const signLocalControlPlaneMessage = async <
  T extends InternalOnionControlPlaneMessage,
>(
  message: T, context?: ReceiveContext
) => {
  await context?.vault.assertMain();
  const signed = await signControlPlaneMessageWithKey(message, await getIdentityPrivateKey(context));
  await context?.vault.assertMain();

  return signed;
};

const resolvePeerIdentityPublicKey = (peerId: string) => {
  const normalizedPeerId = peerId.trim();

  if (!normalizedPeerId) return null;

  const friend = useAppStore.getState().friends.find((candidate) => {
    const candidatePeerIds = [
      candidate.routingHints?.deviceId,
      candidate.primaryDeviceId,
      candidate.deviceId,
    ];

    return candidatePeerIds.some((candidatePeerId) => candidatePeerId?.trim() === normalizedPeerId);
  });

  if (!friend?.identityPub) return null;

  try {
    const publicKey = decodeBase64Url(friend.identityPub);

    return publicKey.byteLength === 32 ? publicKey : null;
  } catch {
    return null;
  }
};

export const verifyPeerControlPlaneMessage = async (
  message: InternalOnionControlPlaneMessage,
  peerId: string, context?: ReceiveContext
) => {
  await context?.vault.assertMain();

  const peers = context ? (await listProfiles(context.vault)).filter(profile => profile.kind === "friend" &&
    profile.friendStatus !== "blocked" && profile.friendStatus !== "deleted" && profile.verification?.status !== "key_changed" &&
    [profile.primaryDeviceId, profile.routingHints?.deviceId].includes(peerId)) : [];

  const publicKey = context ? peers.length === 1 && peers[0].identityPub
    ? decodeBase64Url(peers[0].identityPub) : null : resolvePeerIdentityPublicKey(peerId);

  if (!publicKey) return false;
  const verified = await verifyControlPlaneMessageWithKey(message, publicKey);
  await context?.vault.assertMain();

  return verified;
};
