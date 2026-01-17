export const TTL_MS = 12 * 60 * 60 * 1000;

export const computeExpiresAt = (createdAtMs: number) => createdAtMs + TTL_MS;
