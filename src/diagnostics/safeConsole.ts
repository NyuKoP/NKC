import { sanitizeInfoLogPayload } from "./infoCollectionLogs";

type SafeConsole = Pick<Console, "debug" | "info" | "warn" | "error" | "log">;

export const createSafeConsole = (target: SafeConsole): SafeConsole => {
  const sanitizeArgs = (args: unknown[]) =>
    args.map((value) => {
      const sanitized = sanitizeInfoLogPayload(value);
      if (sanitized === null || typeof sanitized !== "object") return sanitized;
      try {
        return JSON.stringify(sanitized);
      } catch {
        return "[unserializable]";
      }
    });
  return {
    debug: (...args) => target.debug(...sanitizeArgs(args)),
    info: (...args) => target.info(...sanitizeArgs(args)),
    warn: (...args) => target.warn(...sanitizeArgs(args)),
    error: (...args) => target.error(...sanitizeArgs(args)),
    log: (...args) => target.log(...sanitizeArgs(args)),
  };
};
