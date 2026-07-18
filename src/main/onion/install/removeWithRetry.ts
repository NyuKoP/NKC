import fs from "node:fs/promises";

const RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";

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
