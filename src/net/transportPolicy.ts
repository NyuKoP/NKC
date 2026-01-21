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
  const primary: ConversationTransportKind = "onion";
  const fallback: ConversationTransportKind | undefined = input.allowDirect
    ? "direct"
    : undefined;
  return { primary, fallback };
};

export const decideRouterTransport = (
  config: NetConfig,
  controller: RouteController
): RouterTransportKind => {
  if (config.onionEnabled) return "onionRouter";
  if (config.mode === "directP2P") return "directP2P";
  if (config.mode === "onionRouter") return "onionRouter";
  return controller.decideTransport(config);
};
