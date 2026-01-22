type RateLimitState = {
  fails: number;
  nextAllowedAt: number;
};

const states = new Map<string, RateLimitState>();

const nowMs = () => Date.now();

export const checkAllowed = (key: string): { ok: boolean; waitMs?: number } => {
  const state = states.get(key);
  if (!state) return { ok: true };
  const now = nowMs();
  if (now >= state.nextAllowedAt) return { ok: true };
  return { ok: false, waitMs: Math.max(0, state.nextAllowedAt - now) };
};

export const recordFail = (key: string) => {
  const state = states.get(key) ?? { fails: 0, nextAllowedAt: 0 };
  state.fails += 1;
  const delay = Math.min(Math.pow(2, state.fails) * 500, 30000);
  state.nextAllowedAt = nowMs() + delay;
  states.set(key, state);
};

export const recordSuccess = (key: string) => {
  states.delete(key);
};
