export type TransportErrorCode =
  | "ABORTED_TIMEOUT"
  | "ABORTED_PARENT"
  | "FATAL_MISCONFIG"
  | "INTERNAL_ONION_NOT_READY"
  | "TOR_NOT_READY";

export type TransportError = Error & {
  code: TransportErrorCode | string;
  details?: Record<string, unknown>;
};

export const createTransportError = (
  code: TransportErrorCode | string,
  message: string,
  details?: Record<string, unknown>
) => {
  const error = new Error(message) as TransportError;
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
};

export const getTransportErrorCode = (error: unknown) =>
  error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? ((error as { code?: string }).code ?? "")
    : "";
