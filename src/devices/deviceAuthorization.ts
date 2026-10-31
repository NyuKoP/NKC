import { canonicalBytes } from "../crypto/canonicalJson";
import { sanitizeRoutingHints } from "../net/privacy";

/** v2 Root signatures remain valid; v3 carries the approving device's historical membership proof. */
export type DeviceAuthorization = {
  v: 2 | 3;
  kind: "DEVICE_ADDED" | "DEVICE_REVOKED";
  accountRootIdentityPub: string;
  approvedBy: string;
  deviceId: string;
  identityPub: string;
  dhPub: string;
  role: "primary" | "secondary";
  epoch: number;
  ts: number;
  expiresAt: number;
  route?: { onionAddr: string; deviceId: string; inboxWriteToken: string };
  issuer?: DeviceAuthorization;
  retainedApprovals?: string[];
  sig: string;
};

export const MAX_AUTHORIZATION_BYTES = 64 * 1024;

export const MAX_AUTHORITY_ROSTER_BYTES = 1024 * 1024;

const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

/** Shared signature boundary: Main and renderer must accept the same bounded certificate format. */
export const verifyDeviceCertificate = async (event: DeviceAuthorization, root: string,
  verify: (payload: Uint8Array, signature: string, publicKey: string) => boolean | Promise<boolean>) => {
  try {
    if (!key(root) || canonicalBytes(event).length > MAX_AUTHORIZATION_BYTES) return false;
    const seen = new Set<string>();
    let certificate = event;

    for (let depth = 0; depth < 32; depth++) {
      if (!certificate || ![2, 3].includes(certificate.v) || certificate.accountRootIdentityPub !== root ||
          !["DEVICE_ADDED", "DEVICE_REVOKED"].includes(certificate.kind) || !["primary", "secondary"].includes(certificate.role) ||
          !sanitizeRoutingHints({ deviceId: certificate.deviceId })?.deviceId ||
          !sanitizeRoutingHints({ deviceId: certificate.approvedBy })?.deviceId ||
          !key(certificate.identityPub) || !key(certificate.dhPub) || typeof certificate.sig !== "string" ||
          !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(certificate.sig) || !Number.isSafeInteger(certificate.epoch) || certificate.epoch < 1 ||
          !Number.isSafeInteger(certificate.ts) || certificate.ts < 0 || !Number.isSafeInteger(certificate.expiresAt) ||
          certificate.expiresAt <= certificate.ts || depth === 0 && certificate.kind === "DEVICE_ADDED" && certificate.expiresAt <= Date.now()) return false;

      if (certificate.route) {
        const route = sanitizeRoutingHints(certificate.route);

        if (route?.onionAddr !== certificate.route.onionAddr || route?.deviceId !== certificate.deviceId ||
            route?.inboxWriteToken !== certificate.route.inboxWriteToken) return false;
      }

      const { sig, ...payload } = certificate;

      if (certificate.v === 2) return !certificate.issuer && !certificate.retainedApprovals && await verify(canonicalBytes(payload), sig, root);
      const issuer = certificate.issuer;

      if (!issuer || issuer.kind !== "DEVICE_ADDED" || issuer.deviceId !== certificate.approvedBy ||
          certificate.ts < issuer.ts || certificate.ts >= issuer.expiresAt || seen.has(issuer.deviceId) ||
          certificate.kind === "DEVICE_ADDED" && certificate.expiresAt > issuer.expiresAt ||
          certificate.kind === "DEVICE_REVOKED" && (!Array.isArray(certificate.retainedApprovals) || certificate.retainedApprovals.length > 1024 ||
            new Set(certificate.retainedApprovals).size !== certificate.retainedApprovals.length || !certificate.retainedApprovals.every(key)) ||
          certificate.kind === "DEVICE_ADDED" && certificate.retainedApprovals !== undefined ||
          !await verify(canonicalBytes(payload), sig, issuer.identityPub)) return false;
      seen.add(issuer.deviceId);
      certificate = issuer;
    }

    return false;
  } catch { return false; }
};

/** After signature verification, enforce tombstones by exact certificate hash rather than timestamp claims. */
export const authorizationIssuersAllowed = async (event: DeviceAuthorization, registry: Record<string, DeviceAuthorization>,
  digest: (bytes: Uint8Array) => string | Promise<string>) => {
  for (let certificate: DeviceAuthorization | undefined = event; certificate; certificate = certificate.issuer) {
    const issuer = certificate.v === 3 ? registry[certificate.approvedBy] :
      Object.values(registry).find(row => row.identityPub === certificate.accountRootIdentityPub);

    if (issuer?.kind === "DEVICE_REVOKED" && !issuer.retainedApprovals?.includes(await digest(canonicalBytes(certificate)))) return false;

    if (certificate.issuer && issuer && (issuer.identityPub !== certificate.issuer.identityPub || issuer.dhPub !== certificate.issuer.dhPub)) return false;
  }

  return true;
};
