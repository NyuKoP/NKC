import type { OnionNetwork } from "../../../net/netConfig";

export type OnionRuntimeStatus = {
  status: "idle" | "starting" | "running" | "failed";
  network?: OnionNetwork;
  socksPort?: number;
  error?: string;
};

type RoutingTorStatus =
  | { state: "unavailable"; details?: string }
  | { state: "starting"; details?: string }
  | { state: "running"; socksProxyUrl: string; details?: string }
  | { state: "failed"; details: string };

const getLocalSocksPort = (socksProxyUrl: string) => {
  try {
    const parsed = new URL(socksProxyUrl);
    const port = Number.parseInt(parsed.port, 10);

    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
};

export const selectUnifiedOnionRuntimeStatus = (
  componentRuntime: OnionRuntimeStatus,
  routingRuntime: RoutingTorStatus | null
): OnionRuntimeStatus => {
  if (routingRuntime?.state === "running") {
    return {
      status: "running",
      network: "tor",
      socksPort: getLocalSocksPort(routingRuntime.socksProxyUrl),
    };
  }

  if (componentRuntime.status === "running") return componentRuntime;

  if (routingRuntime?.state === "starting") {
    return { status: "starting", network: "tor" };
  }

  if (componentRuntime.status === "starting") return componentRuntime;

  if (routingRuntime?.state === "failed") {
    return {
      status: "failed",
      network: "tor",
      error: routingRuntime.details,
    };
  }

  return componentRuntime;
};
