import { connectConversation, syncContactsNow, syncConversationsNow, type PeerContext } from "../sync/syncEngine";
import { getOrCreateDeviceId } from "../security/deviceRole";
import type { DeviceSyncTransportPolicy } from "../preferences";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import { getAccountRootIdentity, getAuthorizedDevice } from "./deviceApprovals";
import { captureDeviceRegistryContext } from "./deviceRegistry";
import { deviceChannelIdentity } from "../sync/receivedText";

export type DevicePeer = {
  deviceId: string;
  identityPub: string;
  dhPub: string;
  syncTransportPolicy?: DeviceSyncTransportPolicy;
};

const connectDevicePeer = async (peer: DevicePeer) => {
  let context = await captureLocalOperationContext();
  const root = context ? await getAccountRootIdentity(context) : null;
  const authorized = root && context ? await getAuthorizedDevice(peer.deviceId, context) : null;

  if (root && (!authorized?.route || authorized.identityPub !== peer.identityPub || authorized.dhPub !== peer.dhPub)) {
    throw new Error("DEVICE_AUTHORIZATION_REQUIRED");
  }

  if (root && context) context = await captureDeviceRegistryContext(context);
  const localDeviceId = getOrCreateDeviceId(context);
  const convId = deviceChannelIdentity(localDeviceId, peer.deviceId);

  const peerContext: PeerContext = {
    kind: "device",
    peerDeviceId: peer.deviceId,
    friendKeyId: peer.deviceId,
    identityPub: peer.identityPub,
    dhPub: peer.dhPub,
    deviceSyncTransportPolicy: peer.syncTransportPolicy ?? "directOnly",
    ...(authorized?.route ? { accountRootIdentity: root!, deviceAuthorizationVersion: 2 as const, onionAddr: authorized.route.onionAddr,
      inboxWriteToken: authorized.route.inboxWriteToken } : {}),
  };

  await connectConversation(convId, peerContext, context);

  return { convId, context };
};

export const startDeviceSyncAsApprover = async (peer: DevicePeer) => {
  const { context } = await connectDevicePeer(peer);

  if (context && await getAccountRootIdentity(context)) return;
  await syncContactsNow(context);
  await syncConversationsNow(context);
};

export const startDeviceSyncAsInitiator = async (peer: DevicePeer) => {
  await connectDevicePeer(peer);
};
