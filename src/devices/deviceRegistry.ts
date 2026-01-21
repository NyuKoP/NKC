import { getRoleEpoch } from "../security/deviceRole";
import { getPublicStore } from "../security/publicStore";

export type RoleChangeReason = "user" | "recovery" | "handover";

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
const listeners = new Set<(snapshot: RegistrySnapshot) => void>();

const readRegistry = async (): Promise<DeviceRegistry> => {
  const store = getPublicStore();
  const raw = await store.get(REGISTRY_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DeviceRegistry;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
};

const writeRegistry = async (registry: DeviceRegistry) => {
  const store = getPublicStore();
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

export const getRegistry = async () => readRegistry();

export const computeConflict = (registry: DeviceRegistry): ConflictSnapshot => {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const currentEpoch = getRoleEpoch();
  const primaries = Object.values(registry).filter((entry) => {
    if (entry.role !== "primary") return false;
    if (now - entry.lastSeenAt > sevenDaysMs) return false;
    return entry.epoch >= currentEpoch - 1;
  });
  primaries.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return { hasConflict: primaries.length >= 2, primaries };
};

export const getRegistrySnapshot = async (): Promise<RegistrySnapshot> => {
  const registry = await readRegistry();
  return { registry, conflict: computeConflict(registry) };
};

export const updateFromRoleEvent = async (event: RoleChangeEvent): Promise<RegistrySnapshot> => {
  const registry = await readRegistry();
  const existing = registry[event.deviceId];
  const isNewerEpoch = !existing || event.epoch > existing.epoch;
  const isSameEpochNewerTs =
    !!existing && event.epoch === existing.epoch && event.ts >= existing.lastEventTs;
  if (!existing || isNewerEpoch || isSameEpochNewerTs) {
    registry[event.deviceId] = {
      deviceId: event.deviceId,
      role: event.role,
      epoch: event.epoch,
      lastSeenAt: Date.now(),
      lastEventTs: event.ts,
    };
    await writeRegistry(registry);
    const snapshot = { registry, conflict: computeConflict(registry) };
    notify(snapshot);
    return snapshot;
  }

  const snapshot = { registry, conflict: computeConflict(registry) };
  return snapshot;
};

export const onRegistryChange = (listener: (snapshot: RegistrySnapshot) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
