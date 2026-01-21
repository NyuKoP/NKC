const textEncoder = new TextEncoder();

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

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
