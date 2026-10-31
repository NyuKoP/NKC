import { getRoleEpoch } from "../security/deviceRole";
import { getPublicStore } from "../security/publicStore";
import type { ReceiveContext } from "../accounts/receiveContext";
import { captureLocalOperationContext } from "../accounts/receiveContext";
import { writeVault } from "../db/vaultAccess";
import type { Envelope } from "../crypto/box";
import type { DeviceAuthorization } from "./deviceApprovals";
import { decryptJsonRecord, encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";

export type RoleChangeReason = "user" | "handover";

export type RoleChangeEvent = {
  kind: "ROLE_CHANGE";
  deviceId: string;
  role: "primary" | "secondary";
  epoch: number;
  ts: number;
  reason: RoleChangeReason;
};

export type DeviceRegistryEntry = {
  deviceId: string;
  role: "primary" | "secondary";
  epoch: number;
  lastSeenAt: number;
  lastEventTs: number;
  authorization?: DeviceAuthorization;
};

export type DeviceRegistry = Record<string, DeviceRegistryEntry>;

export type ConflictSnapshot = {
  hasConflict: boolean;
  primaries: DeviceRegistryEntry[];
};

export type RegistrySnapshot = {
  registry: DeviceRegistry;
  conflict: ConflictSnapshot;
};

const REGISTRY_KEY = "nkc_device_registry_v1";

export const VAULT_REGISTRY_KEY = "nkc_device_registry_v2";

const listeners = new Set<(snapshot: RegistrySnapshot) => void>();

export const encodeDeviceRegistry = async (registry: DeviceRegistry, context: ReceiveContext) =>
  Object.values(registry).some(entry => entry.authorization) ? JSON.stringify({ v: 3,
    enc_b64: await encryptJsonRecord(context.vault.key, VAULT_REGISTRY_KEY, "device-registry", registry) }) : JSON.stringify(registry);

const readRegistry = async (context?: ReceiveContext): Promise<DeviceRegistry> => {
  context ??= await captureLocalOperationContext();

  if (context) await context.vault.assertMain();
  // No implicit copy of legacy localStorage: the v2 authoritative registry starts empty.
  const raw = context ? (await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value : await getPublicStore().get(REGISTRY_KEY);
  context?.vault.assertLocal();

  if (!raw) return {};

  try {
    const stored = JSON.parse(raw);

    const parsed = stored?.v === 3 && context ? await decryptJsonRecord<DeviceRegistry>(context.vault.key,
      VAULT_REGISTRY_KEY, "device-registry", stored.enc_b64) : stored;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "v" in parsed) throw new Error("DEVICE_REGISTRY_INVALID");

    // Public certificates must not let disk edits bypass the Vault's authority envelope.
    if (context && stored?.v !== 3 && Object.values(parsed).some(entry => entry && typeof entry === "object" && "authorization" in entry)) {
      throw new Error("DEVICE_REGISTRY_INVALID");
    }

    return parsed;
  } catch {
    if (context) throw new Error("DEVICE_REGISTRY_UNREADABLE");

    return {};
  }
};

const writeRegistry = async (registry: DeviceRegistry, context?: ReceiveContext) => {
  const store = getPublicStore(context?.vault);
  await store.set(REGISTRY_KEY, JSON.stringify(registry));
};

const notify = (snapshot: RegistrySnapshot) => {
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  });
};

export const getRegistry = async (context?: ReceiveContext) => readRegistry(context);

/** Keep the verified membership snapshot inside the same final DB fence as application effects. */
export const captureDeviceRegistryContext = async (context: ReceiveContext): Promise<ReceiveContext> => {
  await context.vault.assertMain();
  const registry = await context.vault.db.meta.get(VAULT_REGISTRY_KEY);

  if (!registry) throw new Error("DEVICE_AUTHORIZATION_REQUIRED");

  if (context.vault.authorizationMeta && context.vault.authorizationMeta.value !== registry.value) throw new Error("DEVICE_AUTHORITY_CHANGED");
  await context.vault.assertMain();

  return Object.freeze({ ...context, vault: Object.freeze({ ...context.vault,
    authorizationMeta: Object.freeze({ key: VAULT_REGISTRY_KEY, value: registry.value }) }) });
};

export const computeConflict = (registry: DeviceRegistry, context?: ReceiveContext): ConflictSnapshot => {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const currentEpoch = getRoleEpoch(context);

  const primaries = Object.values(registry).filter((entry) => {
    if (entry.role !== "primary") return false;

    if (now - entry.lastSeenAt > sevenDaysMs) return false;

    return entry.epoch >= currentEpoch - 1;
  });

  primaries.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return { hasConflict: primaries.length >= 2, primaries };
};

export const getRegistrySnapshot = async (context?: ReceiveContext): Promise<RegistrySnapshot> => {
  const registry = await readRegistry(context);

  return { registry, conflict: computeConflict(registry, context) };
};

export const updateFromRoleEvent = async (event: RoleChangeEvent, context?: ReceiveContext): Promise<RegistrySnapshot> => {
  context ??= await captureLocalOperationContext();

  if (context) throw new Error("ROLE_SHORT_COMMIT_REQUIRED");
  const registry = await readRegistry(context);
  const existing = registry[event.deviceId];
  const isNewerEpoch = !existing || event.epoch > existing.epoch;

  const isSameEpochNewerTs =
    !!existing && event.epoch === existing.epoch && event.ts >= existing.lastEventTs;

  if (!existing || isNewerEpoch || isSameEpochNewerTs) {
    registry[event.deviceId] = {
      ...existing,
      deviceId: event.deviceId,
      role: event.role,
      epoch: event.epoch,
      lastSeenAt: Date.now(),
      lastEventTs: event.ts,
    };
    await writeRegistry(registry, context);
    const snapshot = { registry, conflict: computeConflict(registry, context) };
    notify(snapshot);

    return snapshot;
  }

  const snapshot = { registry, conflict: computeConflict(registry, context) };

  return snapshot;
};

export const commitAuthenticatedRoleEvent = async (event: RoleChangeEvent, envelope: Envelope, eventHash: string, context: ReceiveContext) => {
  await context.vault.assertMain();
  const db = context.vault.db;
  const beforeRegistry = await db.meta.get(VAULT_REGISTRY_KEY);
  const beforeEvent = await db.events.get(envelope.header.eventId);

  if (!beforeEvent?.authenticatedBody_enc || beforeEvent.eventHash !== eventHash ||
      !beforeEvent.applicationCryptoCommitted || beforeEvent.applicationState !== "pending") throw new Error("ROLE_APPLICATION_CONFLICT");
  const registry = await readRegistry(context);
  const existing = registry[event.deviceId];

  if (!existing || event.epoch > existing.epoch || event.epoch === existing.epoch && event.ts >= existing.lastEventTs) {
    registry[event.deviceId] = { ...existing, deviceId: event.deviceId, role: event.role, epoch: event.epoch,
      lastSeenAt: Date.now(), lastEventTs: event.ts };
  }

  const value = await encodeDeviceRegistry(registry, context);
  await writeVault(context.vault, [db.meta, db.events], async () => {
    const candidate = await db.events.get(envelope.header.eventId);

    if (candidate?.eventHash !== eventHash || !sameStoredCiphertext(candidate.authenticatedBody_enc, beforeEvent.authenticatedBody_enc) ||
        candidate.applicationState !== "pending" || !candidate.applicationCryptoCommitted ||
        (await db.meta.get(VAULT_REGISTRY_KEY))?.value !== beforeRegistry?.value) throw new Error("ROLE_APPLICATION_CONFLICT");
    await db.meta.put({ key: VAULT_REGISTRY_KEY, value });
    await db.events.update(envelope.header.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
    const key = `lamport_v1:${envelope.header.convId}`;
    const current = Number((await db.meta.get(key))?.value ?? 0);
    await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, envelope.header.lamport)) });
  }, value);
  context.vault.assertLocal();
  notify({ registry, conflict: computeConflict(registry, context) });

  return true;
};

export const onRegistryChange = (listener: (snapshot: RegistrySnapshot) => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};
