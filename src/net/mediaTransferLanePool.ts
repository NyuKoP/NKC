type LaneState = {
  active: number;
  waiting: Array<() => void>;
};

export const createMediaTransferLanePool = (maxLanes = 3) => {
  const laneLimit = Math.max(1, Math.floor(maxLanes));
  const states = new Map<string, LaneState>();

  const acquire = async (key: string) => {
    const state = states.get(key) ?? { active: 0, waiting: [] };
    states.set(key, state);

    if (state.active >= laneLimit) {
      await new Promise<void>((resolve) => state.waiting.push(resolve));
    }

    state.active += 1;

    let released = false;

    return () => {
      if (released) return;
      released = true;
      state.active -= 1;
      const next = state.waiting.shift();

      if (next) {
        next();
      } else if (state.active === 0) {
        states.delete(key);
      }
    };
  };

  const run = async <T>(key: string, task: () => Promise<T>) => {
    const release = await acquire(key);

    try {
      return await task();
    } finally {
      release();
    }
  };

  return { run };
};
