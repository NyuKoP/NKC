import { connectConversation, syncContactsNow, syncConversationsNow, type PeerContext } from "../sync/syncEngine";
import { getOrCreateDeviceId } from "../security/deviceRole";

export type DevicePeer = {
  deviceId: string;
  identityPub: string;
  dhPub: string;
};

const buildDeviceSyncConvId = (a: string, b: string) => {
  const [first, second] = [a, b].sort();
  return `device-sync:${first}:${second}`;
};

const connectDevicePeer = async (peer: DevicePeer) => {
  const localDeviceId = getOrCreateDeviceId();
  const convId = buildDeviceSyncConvId(localDeviceId, peer.deviceId);
  const peerContext: PeerContext = {
    kind: "device",
    peerDeviceId: peer.deviceId,
    friendKeyId: peer.deviceId,
    identityPub: peer.identityPub,
    dhPub: peer.dhPub,
  };
  await connectConversation(convId, peerContext);
  return convId;
};

export const startDeviceSyncAsApprover = async (peer: DevicePeer) => {
  await connectDevicePeer(peer);
  await syncContactsNow();
  await syncConversationsNow();
};

export const startDeviceSyncAsInitiator = async (peer: DevicePeer) => {
  await connectDevicePeer(peer);
};
