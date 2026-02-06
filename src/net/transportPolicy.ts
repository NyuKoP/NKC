import type { NetConfig } from "./netConfig";
import type { RouteController } from "./routeController";
import type { TransportKind as ConversationTransportKind } from "./transport";

export type RouterTransportKind = "directP2P" | "selfOnion" | "onionRouter";

type ConversationPolicyInput = {
  allowDirect: boolean;
};

export const decideConversationTransport = (
  input: ConversationPolicyInput
) => {
  if (input.allowDirect) {
    return {
      primary: "direct" as const,
      fallback: "onion" as const,
    };
  }
  const primary: ConversationTransportKind = "onion";
  const fallback: ConversationTransportKind | undefined = undefined;
  return { primary, fallback };
};

export const decideRouterTransport = (
  config: NetConfig,
  controller: RouteController
): RouterTransportKind => {
  if (config.onionEnabled) return "onionRouter";
  if (config.mode === "onionRouter") return "onionRouter";
  if (config.mode === "selfOnion") return "selfOnion";
  if (config.mode === "directP2P") return "directP2P";
  return controller.decideTransport(config);
};
