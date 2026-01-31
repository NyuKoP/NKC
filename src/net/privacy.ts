const ipv4Pattern =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const ipv6Pattern = /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;
const icePattern = /(candidate:|a=candidate)/gi;

export const redactIPs = (value: string) => {
  if (!value) return value;
  return value
    .replace(ipv4Pattern, "[redacted-ip]")
    .replace(ipv6Pattern, "[redacted-ip]")
    .replace(icePattern, "candidate:[redacted]");
};

export const looksLikeIpOrIce = (value: string) =>
  ipv4Pattern.test(value) || ipv6Pattern.test(value) || icePattern.test(value);

export const sanitizeRoutingHints = (
  hints?: { onionAddr?: string; lokinetAddr?: string; deviceId?: string }
) => {
  if (!hints) return undefined;
  const next: { onionAddr?: string; lokinetAddr?: string; deviceId?: string } = {};
  if (hints.onionAddr && !looksLikeIpOrIce(hints.onionAddr)) {
    next.onionAddr = hints.onionAddr;
  }
  if (hints.lokinetAddr && !looksLikeIpOrIce(hints.lokinetAddr)) {
    next.lokinetAddr = hints.lokinetAddr;
  }
  if (typeof hints.deviceId === "string") {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(hints.deviceId)) {
      next.deviceId = hints.deviceId;
    }
  }
  return Object.keys(next).length ? next : undefined;
};
