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
  void input;
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
  const chosen = controller.decideTransport(config);
  return chosen === "directP2P" ? "selfOnion" : chosen;
};
