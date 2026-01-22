import { canonicalBytes } from "../crypto/canonicalJson";
import { getLastEventHash, saveEvent } from "../db/repo";
import { createId } from "../utils/ids";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { getDhPublicKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import { getPublicStore } from "../security/publicStore";
import { getSodium } from "../security/sodium";
import { getOrCreateDeviceId } from "../security/deviceRole";

export type DeviceAddedPayload = {
  kind: "DEVICE_ADDED";
  deviceId: string;
  identityPub: string;
  dhPub: string;
  ts: number;
  expiresAt: number;
  approvedBy: string;
  approverIdentityPub: string;
  approverDhPub: string;
};

export type DeviceAddedEvent = DeviceAddedPayload & {
  sig: string;
};

const APPROVAL_STORE_KEY = "nkc_device_approvals_v1";
const DEFAULT_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_APPROVAL_LOG_ID = "device-approvals";

const readApprovals = async (): Promise<Record<string, DeviceAddedEvent>> => {
  const store = getPublicStore();
  const raw = await store.get(APPROVAL_STORE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, DeviceAddedEvent>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
};

const writeApprovals = async (approvals: Record<string, DeviceAddedEvent>) => {
  const store = getPublicStore();
  await store.set(APPROVAL_STORE_KEY, JSON.stringify(approvals));
};

const stripSig = (event: DeviceAddedEvent): DeviceAddedPayload => {
  const { sig, ...payload } = event;
  void sig;
  return payload;
};

const computeApprovalEventHash = async (event: DeviceAddedEvent) => {
  const sodium = await getSodium();
  const hash = sodium.crypto_generichash(32, canonicalBytes(event));
  return encodeBase64Url(hash);
};

export const createDeviceAddedEvent = async (input: {
  deviceId: string;
  identityPub: string;
  dhPub: string;
  expiresAt?: number;
}) => {
  const now = Date.now();
  const approverDeviceId = getOrCreateDeviceId();
  const [identityPriv, identityPub, dhPub] = await Promise.all([
    getIdentityPrivateKey(),
    getIdentityPublicKey(),
    getDhPublicKey(),
  ]);

  const payload: DeviceAddedPayload = {
    kind: "DEVICE_ADDED",
    deviceId: input.deviceId,
    identityPub: input.identityPub,
    dhPub: input.dhPub,
    ts: now,
    expiresAt: input.expiresAt ?? now + DEFAULT_APPROVAL_TTL_MS,
    approvedBy: approverDeviceId,
    approverIdentityPub: encodeBase64Url(identityPub),
    approverDhPub: encodeBase64Url(dhPub),
  };

  const sodium = await getSodium();
  const sig = sodium.crypto_sign_detached(canonicalBytes(payload), identityPriv);
  return { ...payload, sig: encodeBase64Url(sig) } satisfies DeviceAddedEvent;
};

export const verifyDeviceAddedEvent = async (event: DeviceAddedEvent) => {
  if (!event || event.kind !== "DEVICE_ADDED") return false;
  if (
    !event.sig ||
    !event.approverIdentityPub ||
    !event.approverDhPub ||
    !event.deviceId ||
    !event.identityPub ||
    !event.dhPub ||
    !event.approvedBy
  ) {
    return false;
  }
  if (!Number.isFinite(event.ts) || !Number.isFinite(event.expiresAt)) return false;
  if (event.expiresAt <= Date.now()) return false;

  try {
    const sodium = await getSodium();
    const sig = decodeBase64Url(event.sig);
    const verifyKey = decodeBase64Url(event.approverIdentityPub);
    const payload = stripSig(event);
    return sodium.crypto_sign_verify_detached(sig, canonicalBytes(payload), verifyKey);
  } catch {
    return false;
  }
};

export const storeDeviceApproval = async (event: DeviceAddedEvent) => {
  const ok = await verifyDeviceAddedEvent(event);
  if (!ok) return false;
  const approvals = await readApprovals();
  approvals[event.deviceId] = event;
  await writeApprovals(approvals);
  const prevHash = await getLastEventHash(DEVICE_APPROVAL_LOG_ID);
  const eventHash = await computeApprovalEventHash(event);
  await saveEvent({
    eventId: createId(),
    convId: DEVICE_APPROVAL_LOG_ID,
    authorDeviceId: event.approvedBy,
    lamport: event.ts,
    ts: event.ts,
    envelopeJson: JSON.stringify(event),
    prevHash,
    eventHash,
  });
  return true;
};

export const getApprovedDevice = async (deviceId: string) => {
  const approvals = await readApprovals();
  const event = approvals[deviceId];
  if (!event) return null;
  const valid = await verifyDeviceAddedEvent(event);
  if (!valid) {
    delete approvals[deviceId];
    await writeApprovals(approvals);
    return null;
  }
  return event;
};

export const getDeviceApproval = async (deviceId: string) => getApprovedDevice(deviceId);

export const isDeviceApproved = async (deviceId: string) => {
  const event = await getApprovedDevice(deviceId);
  return Boolean(event);
};
