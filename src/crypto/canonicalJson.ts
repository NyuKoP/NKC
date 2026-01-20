const textEncoder = new TextEncoder();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const next: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      next[key] = canonicalize(value[key]);
    }
    return next;
  }
  return value;
};

export const canonicalBytes = (value: unknown) =>
  textEncoder.encode(JSON.stringify(canonicalize(value)));
