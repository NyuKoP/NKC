import type { InfoLogErrorDetail } from "./infoCollectionLogs";

export const toInfoLogErrorDetail = (error: unknown): InfoLogErrorDetail => {
  if (error instanceof Error) {
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code?: string }).code ?? undefined)
        : undefined;
    const cause =
      typeof (error as { cause?: unknown }).cause === "string"
        ? ((error as { cause?: string }).cause ?? undefined)
        : undefined;
    return {
      name: error.name,
      message: error.message,
      code,
      stackTop: error.stack?.split("\n").slice(0, 3).join("\n"),
      causeMessage: cause,
    };
  }
  return {
    message: String(error),
  };
};

export const splitRouteErrorParts = (input?: string) =>
  typeof input === "string"
    ? input
        .split("||")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];

const normalizeRouteErrorCode = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9:]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

export const collectRouteErrorCodes = (errorParts: string[]) => {
  const codes = new Set<string>();
  for (const part of errorParts) {
    const prefixedMatch = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(part);
    const prefix = prefixedMatch ? normalizeRouteErrorCode(prefixedMatch[1]) : "";
    const detail = (prefixedMatch ? prefixedMatch[2] : part).trim();
    const directCodes = [...detail.matchAll(/([a-z_]+:[a-z0-9_:-]+)/gi)].map((m) =>
      normalizeRouteErrorCode(m[1])
    );
    for (const code of directCodes) {
      if (!code) continue;
      codes.add(prefix && !code.startsWith(`${prefix}:`) ? `${prefix}:${code}` : code);
    }
    if (/direct p2p data channel is not open/i.test(detail)) {
      codes.add(`${prefix || "directp2p"}:channel_not_open`);
    }
    if (/internal onion route is not ready/i.test(detail)) {
      codes.add(`${prefix || "selfonion"}:route_not_ready`);
    }
    if (/forward_failed:no_route/i.test(detail)) {
      codes.add(`${prefix || "onionrouter"}:forward_failed:no_route`);
    }
    if (/forward_failed:no_route_target/i.test(detail)) {
      codes.add(`${prefix || "onionrouter"}:forward_failed:no_route_target`);
    }
    if (/this operation was aborted/i.test(detail)) {
      codes.add(`${prefix || "router"}:aborted`);
    }
    if (/send failed/i.test(detail)) {
      codes.add(`${prefix || "router"}:send_failed`);
    }
  }
  return [...codes];
};

export const classifyRouteFailure = (errorCodes: string[], errorParts: string[]) => {
  const text = `${errorCodes.join(" ")} ${errorParts.join(" ")}`.toLowerCase();
  if (text.includes("missing destination 'to'") || text.includes("missing-to-device")) {
    return "missing-device-id";
  }
  if (
    text.includes("no_proxy") ||
    text.includes("proxy_unreachable") ||
    text.includes("onion controller unavailable")
  ) {
    return "onion-proxy-not-ready";
  }
  if (text.includes("channel_not_open")) {
    return "direct-channel-not-open";
  }
  if (text.includes("route_not_ready")) {
    return "self-onion-not-ready";
  }
  if (text.includes("forward_failed:no_route_target") || text.includes("forward_failed:no_route")) {
    return "missing-route-target";
  }
  if (text.includes("aborted")) {
    return "transport-aborted";
  }
  if (text.includes("send_failed")) {
    return "transport-send-failed";
  }
  return "unknown-route-failure";
};
