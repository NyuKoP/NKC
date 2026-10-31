import type { NetConfig } from "./netConfig";
import type { RouteController } from "./routeController";
import type { TransportKind as ConversationTransportKind } from "./transport";
import { createTransportError } from "./transportErrors";

export type RouterTransportKind = "directP2P" | "selfOnion" | "onionRouter";

export const assertTorBackedTransport = (kind: string) => {
  if (kind === "direct" || kind === "directP2P") {
    throw createTransportError("UNSUPPORTED_LEGACY_TRANSPORT", "Direct transport is unsupported in this release. Select Tor in Network settings.");
  }
};

export const assertSupportedNetworkConfig = (config: NetConfig) => assertTorBackedTransport(config.mode);

type ConversationPolicyInput = {
  allowDirect: boolean;
  directOnly?: boolean;
};

export const decideConversationTransport = (
  input: ConversationPolicyInput
) => {
  if (input.directOnly || input.allowDirect) assertTorBackedTransport("direct");
  const primary: ConversationTransportKind = "onion";
  const fallback: ConversationTransportKind | undefined = undefined;

  return { primary, fallback };
};

export const decideRouterTransport = (
  config: NetConfig,
  controller: Pick<RouteController, "decideTransport">
): RouterTransportKind => {
  assertSupportedNetworkConfig(config);

  if (config.onionEnabled) return "onionRouter";

  if (config.mode === "onionRouter") return "onionRouter";

  if (config.mode === "selfOnion") return "selfOnion";
  const selected = controller.decideTransport(config);
  assertTorBackedTransport(selected);

  return selected;
};
