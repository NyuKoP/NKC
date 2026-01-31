import type { NetConfig } from "./netConfig";
import type { NetworkMode } from "./mode";

export type RouteInfo = {
  mode: NetworkMode;
  description: string;
  pathLabel: string;
};

export const getRouteInfo = (mode: NetworkMode, config: NetConfig): RouteInfo => {
  void config;
  if (mode === "selfOnion") {
    return {
      mode,
      description: "내장 온니언 라우팅으로 여러 홉을 경유합니다.",
      pathLabel: "나 → hop1 → hop2 → ... → 상대 (N hops)",
    };
  }
  return {
    mode,
    description: "외부 온니언(Tor/Lokinet) 경로로 연결합니다.",
    pathLabel: "나 → hop1 → hop2 → ... → 상대 (N hops)",
  };
};
