import { probeNetworkStages } from "./torProbeError";

const MAX_EVENT_BYTES = 16 * 1024;
const ALLOWED_CHANNELS = new Set(["friend-add", "friend-route", "router"]);
const SUPPRESSED_ROUTER_EVENTS = new Set(["deliveryWorker:tick"]);
const SENSITIVE_KEY = /(friendcode|onion|destination|deviceid|friendid|profileid|identity|private|secret|token|password|ciphertext|plaintext|message|text|body|filename)/i;
const SAFE_AGGREGATE_KEY = /(?:count|bytes|ms|attempted|succeeded|failed|skipped|present)$/i;
type DiagnosticRecord = { channel: string; at?: string; event: unknown };

const sanitizeString = (value: string) =>
  value
    .replace(/\b[a-z2-7]{56}\.onion\b/gi, "[onion-redacted]")
    .replace(/\bNKC(?:D1|C1)-[A-Za-z0-9_-]+\b/g, "[diagnostic-code-redacted]")
    .replace(/\bNKC1-[A-Za-z0-9_-]+\b/g, "[friend-code-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .slice(0, 2000);

const sanitizeValue = (value: unknown, depth = 0, forwardTimings = false): unknown => {
  if (depth >= 6) return "[depth-limited]";

  if (typeof value === "string") return sanitizeString(value);

  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));

  if (!value || typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (item === undefined) continue;

    if (key === "stageDurationsMs" || key === "connectionCounts") {
      result[key] = depth === 0 && forwardTimings
        ? Object.fromEntries(item && typeof item === "object" && !Array.isArray(item)
          ? Object.entries(item).slice(0, 80).filter(([stage, duration]) =>
            (key === "connectionCounts" ? ["new", "reused"].includes(stage)
              : probeNetworkStages.some(allowed => allowed !== "unknown" && allowed === stage)) &&
            typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0)
          : [])
        : "[redacted]";
      continue;
    }

    result[key] =
      SENSITIVE_KEY.test(key) && !SAFE_AGGREGATE_KEY.test(key)
        ? "[redacted]"
        : sanitizeValue(item, depth + 1);
  }

  return result;
};

export const sanitizeDiagnosticRecord = (
  record: DiagnosticRecord
): DiagnosticRecord | null => {
  const channel = typeof record?.channel === "string" ? record.channel.trim() : "";

  if (!ALLOWED_CHANNELS.has(channel)) return null;

  const eventName =
    record.event && typeof record.event === "object" && "event" in record.event
      ? String(record.event.event ?? "")
      : "";

  if (eventName.startsWith("diagnostic:control:")) return null;
  if (channel === "router" && SUPPRESSED_ROUTER_EVENTS.has(eventName)) return null;

  const sanitized: DiagnosticRecord = {
    channel,
    at:
      typeof record.at === "string" && !Number.isNaN(Date.parse(record.at))
        ? record.at
        : new Date().toISOString(),
    event: sanitizeValue(record.event, 0, channel === "router" &&
      ["onionController:forward:ok", "onionController:forward:fail"].includes(eventName)),
  };

  return Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= MAX_EVENT_BYTES
    ? sanitized
    : null;
};
