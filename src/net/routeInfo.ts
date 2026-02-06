import type { NetConfig } from "./netConfig";
import type { NetworkMode } from "./mode";
import type { InternalOnionRouteState } from "./internalOnion/types";

export type RouteInfo = {
  mode: NetworkMode;
  description: string;
  pathLabel: string;
};

export const getRouteInfo = (
  mode: NetworkMode,
  config: NetConfig,
  internalRouteState?: InternalOnionRouteState
): RouteInfo => {
  if (mode === "directP2P") {
    if (config.webrtcRelayOnly) {
      return {
        mode,
        description: "가능한 경우 릴레이(TURN)로 IP를 보호합니다.",
        pathLabel: "나 → 릴레이 → 상대 (1 hop)",
      };
    }
    return {
      mode,
      description: "상대와 직접 연결합니다.",
      pathLabel: "나 → 상대 (0 hops)",
    };
  }

  if (mode === "selfOnion") {
    const desiredHops = internalRouteState?.desiredHops ?? config.selfOnionMinRelays;
    const establishedHops = internalRouteState?.establishedHops ?? 0;
    return {
      mode,
      description: "내장 온니언 라우팅으로 여러 홉을 경유합니다.",
      pathLabel: `나 → hop1 → hop2 → ... → 상대 (${establishedHops}/${desiredHops} hops)`,
    };
  }

  return {
    mode,
    description: "외부 온니언(Tor/Lokinet) 경로로 연결합니다.",
    pathLabel: "나 → hop1 → hop2 → ... → 상대 (N hops)",
  };
};

