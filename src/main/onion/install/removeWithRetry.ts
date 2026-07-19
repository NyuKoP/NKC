import fs from "node:fs/promises";

const RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";

const verifyRemoved = async (targetPath: string) => {
  try {
    await fs.lstat(targetPath);
    const error = new Error(`Path still exists after removal: ${targetPath}`) as Error & {
      code?: string;
    };
    error.code = "ENOTEMPTY";
    throw error;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return;
    throw error;
  }
};

export const removeWithRetry = async (
  targetPath: string,
  opts: { attempts?: number; baseDelayMs?: number } = {}
) => {
  const attempts = opts.attempts ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 150;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      await verifyRemoved(targetPath);
      return;
    } catch (error) {
      lastError = error;
      const code = getErrorCode(error);
      if (!RETRYABLE_CODES.has(code) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(baseDelayMs * (attempt + 1));
    }
  }

  throw lastError;
};
