type Priority = "high" | "normal";

type WaitingSend = { priority: Priority; start: () => void; reject: (error: Error) => void };

// Keep bulk transfers from occupying every native HTTP/SOCKS request slot.
// Already-running requests finish normally; queued chat runs before queued media.
export const createPrioritySendQueue = (limit = 6, normalLimit = 4) => {
  if (!Number.isInteger(limit) || !Number.isInteger(normalLimit) || normalLimit < 1 || normalLimit >= limit) {
    throw new Error("invalid_send_queue_limits");
  }

  let active = 0;
  let normalActive = 0;
  let closed = false;
  const waiting: WaitingSend[] = [];
  const pending = new Map<string, Promise<unknown>>();

  const drain = () => {
    while (active < limit) {
      let index = waiting.findIndex((item) => item.priority === "high");

      if (index < 0 && normalActive < normalLimit) index = 0;

      if (index < 0 || !waiting.length) return;
      const [item] = waiting.splice(index, 1);
      active += 1;

      if (item.priority === "normal") normalActive += 1;
      item.start();
    }
  };

  const run = <T>(priority: Priority, task: () => Promise<T>, id?: string): Promise<T> => {
    const existing = id ? pending.get(id) : undefined;

    if (existing) return existing as Promise<T>;

    const result = new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error("TOR_NOT_READY: send queue closed"));

        return;
      }

      // Backpressure remains durable in the router's outbox on rejection.
      if (waiting.length >= 256) {
        reject(new Error("send_queue_full"));

        return;
      }

      waiting.push({
        priority,
        reject,
        start: () => {
          void Promise.resolve().then(task).then(resolve, reject).finally(() => {
            active -= 1;

            if (priority === "normal") normalActive -= 1;
            drain();
          });
        },
      });
      drain();
    });

    if (id) {
      pending.set(id, result);
      void result.finally(() => pending.delete(id)).catch(() => {});
    }

    return result;
  };

  const close = () => {
    closed = true;

    for (const item of waiting.splice(0)) item.reject(new Error("TOR_NOT_READY: send queue closed"));
  };

  return { run, close };
};
