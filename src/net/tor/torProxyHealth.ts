type SocksHealthBridge = {
  checkSocksProxyReachable?: (payload: {
    socksUrl: string;
    timeoutMs?: number;
  }) => Promise<boolean>;
};

const getBridge = (): SocksHealthBridge | null => {
  const candidate = (
    globalThis as {
      nkc?: SocksHealthBridge;
    }
  ).nkc;
  return candidate ?? null;
};

const toPositiveTimeout = (value: number) => {
  if (!Number.isFinite(value)) return 2000;
  return Math.max(1, Math.round(value));
};

export const checkSocksProxyReachable = async (
  socksUrl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> => {
  const bridge = getBridge();
  if (!bridge?.checkSocksProxyReachable) return false;
  if (signal?.aborted) return false;
  const run = bridge
    .checkSocksProxyReachable({
      socksUrl,
      timeoutMs: toPositiveTimeout(timeoutMs),
    })
    .catch(() => false);
  if (!signal) {
    return run;
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void run.then((value) => finish(value));
  });
};
