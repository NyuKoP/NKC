import { describe, expect, it } from "vitest";
import { decideConversationTransport, decideRouterTransport } from "../transportPolicy";
import type { RouteController } from "../routeController";

describe("transportPolicy", () => {
  it("prefers direct with onion fallback when direct is allowed", () => {
    const decision = decideConversationTransport({ allowDirect: true });
    expect(decision.primary).toBe("direct");
    expect(decision.fallback).toBe("onion");
  });

  it("uses onion only when direct is not allowed", () => {
    const decision = decideConversationTransport({ allowDirect: false });
    expect(decision.primary).toBe("onion");
    expect(decision.fallback).toBeUndefined();
  });

  it("selects directP2P in direct mode", () => {
    const controller = { decideTransport: () => "selfOnion" } as unknown as RouteController;
    const result = decideRouterTransport(
      {
        mode: "directP2P",
        onionProxyEnabled: false,
        onionProxyUrl: "",
        webrtcRelayOnly: false,
        disableLinkPreview: false,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: false,
        onionSelectedNetwork: "tor",
        tor: { installed: false, status: "idle" },
        lokinet: { installed: false, status: "idle" },
      },
      controller
    );
    expect(result).toBe("directP2P");
  });

  it("forces onionRouter when onion protection is enabled", () => {
    const controller = { decideTransport: () => "directP2P" } as unknown as RouteController;
    const result = decideRouterTransport(
      {
        mode: "directP2P",
        onionProxyEnabled: true,
        onionProxyUrl: "socks5://127.0.0.1:9050",
        webrtcRelayOnly: true,
        disableLinkPreview: true,
        selfOnionEnabled: true,
        selfOnionMinRelays: 3,
        allowRemoteProxy: false,
        onionEnabled: true,
        onionSelectedNetwork: "tor",
        tor: { installed: true, status: "ready" },
        lokinet: { installed: false, status: "idle" },
      },
      controller
    );
    expect(result).toBe("onionRouter");
  });
});
