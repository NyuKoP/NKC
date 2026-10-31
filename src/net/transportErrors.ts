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
  const error: TransportError = Object.assign(new Error(message), { code });

  if (details) {
    error.details = details;
  }

  return error;
};

export const getTransportErrorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? (error.code ?? "")
    : "";
