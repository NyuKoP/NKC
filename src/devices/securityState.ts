import { canonicalBytes } from "../crypto/canonicalJson";
import { encodeBase64Url } from "../security/base64url";
import type { DeviceAuthorization } from "./deviceApprovals";

export const sameCertificate = (a: DeviceAuthorization, b: DeviceAuthorization) =>
  encodeBase64Url(canonicalBytes(a)) === encodeBase64Url(canonicalBytes(b));

/** Call only after verifying every certificate against the pinned Root. No unsigned aggregate clock. */
export const selectSecurityUpdates = (local: Record<string, DeviceAuthorization>, incoming: DeviceAuthorization[]) => {
  if (!Array.isArray(incoming) || incoming.length > 32 || new Set(incoming.map(row => row.deviceId)).size !== incoming.length) {
    throw new Error("DEVICE_AUTHORIZATION_INVALID");
  }
  return incoming.filter(certificate => {
    const previous = local[certificate.deviceId];
    if (!previous || sameCertificate(previous, certificate)) return !previous;
    if (previous.accountRootIdentityPub !== certificate.accountRootIdentityPub || previous.identityPub !== certificate.identityPub ||
        previous.dhPub !== certificate.dhPub || previous.epoch === certificate.epoch ||
        previous.kind === "DEVICE_REVOKED" && certificate.epoch > previous.epoch && certificate.kind !== "DEVICE_REVOKED") {
      throw new Error("SECURITY_STATE_CONFLICT");
    }
    return certificate.epoch > previous.epoch && previous.kind !== "DEVICE_REVOKED";
  });
};
