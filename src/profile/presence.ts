export const PRESENCE_STATUSES = ["online", "idle", "dnd", "offline"] as const;

export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const PRESENCE_HEARTBEAT_MS = 15_000;

export const PRESENCE_TTL_MS = 45_000;

export type ProfilePresence = {
  status: PresenceStatus;
  updatedAt: number;
  expiresAt?: number;
};

export const isPresenceStatus = (value: unknown): value is PresenceStatus =>
  typeof value === "string" && PRESENCE_STATUSES.some((status) => status === value);

export const createProfilePresence = (
  status: PresenceStatus,
  now = Date.now()
): ProfilePresence => ({
  status,
  updatedAt: now,
  ...(status === "offline" ? {} : { expiresAt: now + PRESENCE_TTL_MS }),
});

export const createSharedProfilePresence = (
  status: PresenceStatus,
  hidePresence: boolean,
  now = Date.now()
) => createProfilePresence(hidePresence ? "offline" : status, now);

export const resolvePresenceStatus = (
  presence: ProfilePresence | null | undefined,
  now = Date.now()
): PresenceStatus => {
  if (!presence || !isPresenceStatus(presence.status)) return "offline";

  if (presence.status === "offline") return "offline";

  if (!Number.isFinite(presence.expiresAt) || Number(presence.expiresAt) <= now) return "offline";

  return presence.status;
};

export const presenceDotClass = (status: PresenceStatus) => {
  if (status === "online") return "bg-emerald-500";

  if (status === "idle") return "bg-amber-400";

  if (status === "dnd") return "bg-rose-500";

  return "bg-slate-500";
};
