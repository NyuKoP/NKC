export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];
  const concurrency = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let active = 0;

  return new Promise<R[]>((resolve, reject) => {
    const launch = () => {
      if (nextIndex >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && nextIndex < items.length) {
        const current = nextIndex++;
        active += 1;
        Promise.resolve(fn(items[current], current))
          .then((value) => {
            results[current] = value;
            active -= 1;
            launch();
          })
          .catch(reject);
      }
    };

    launch();
  });
}
