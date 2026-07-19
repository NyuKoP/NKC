export type DeviceRole = "primary" | "secondary";

const DEVICE_ID_KEY = "nkc_device_id_v1";
const DEVICE_ROLE_KEY = "nkc_device_role_v1";
const ROLE_EPOCH_KEY = "nkc_role_epoch_v1";
const PRIMARY_DEVICE_ID_KEY = "nkc_primary_device_id_v1";

const memoryStore = new Map<string, string>();

const getStorage = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const getValue = (key: string) => {
  const storage = getStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }
  return memoryStore.get(key) ?? null;
};

const setValue = (key: string, value: string) => {
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(key, value);
      return;
    } catch {
      return;
    }
  }
  memoryStore.set(key, value);
};

const createUuid = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random generator is unavailable");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const getOrCreateDeviceId = () => {
  const existing = getValue(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = createUuid();
  setValue(DEVICE_ID_KEY, id);
  return id;
};

export const getDeviceRole = (): DeviceRole => {
  const existing = getValue(DEVICE_ROLE_KEY);
  if (existing === "primary" || existing === "secondary") return existing;
  const defaultRole: DeviceRole = "primary";
  setValue(DEVICE_ROLE_KEY, defaultRole);
  return defaultRole;
};

export const setDeviceRole = (role: DeviceRole) => {
  setValue(DEVICE_ROLE_KEY, role);
};

export const isPrimary = () => getDeviceRole() === "primary";

export const assertPrimaryOrThrow = (actionName: string) => {
  if (isPrimary()) return;
  const error = new Error(`Primary device required for ${actionName}`);
  (error as { code?: string; action?: string }).code = "PRIMARY_ONLY";
  (error as { code?: string; action?: string }).action = actionName;
  throw error;
};

export const getRoleEpoch = () => {
  const raw = getValue(ROLE_EPOCH_KEY);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const bumpRoleEpoch = () => {
  const next = getRoleEpoch() + 1;
  setValue(ROLE_EPOCH_KEY, String(next));
  return next;
};

export const promoteToPrimary = () => {
  const deviceId = getOrCreateDeviceId();
  setDeviceRole("primary");
  const epoch = bumpRoleEpoch();
  setValue(PRIMARY_DEVICE_ID_KEY, deviceId);
  return { deviceId, role: "primary" as const, epoch };
};

export const demoteToSecondary = () => {
  const deviceId = getOrCreateDeviceId();
  setDeviceRole("secondary");
  const epoch = getRoleEpoch();
  return { deviceId, role: "secondary" as const, epoch };
};
