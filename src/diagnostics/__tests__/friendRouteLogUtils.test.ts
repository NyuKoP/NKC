import { describe, expect, it } from "vitest";
import {
  classifyRouteFailure,
  collectRouteErrorCodes,
  splitRouteErrorParts,
} from "../friendRouteLogUtils";

const classify = (input: string) => {
  const parts = splitRouteErrorParts(input);
  const codes = collectRouteErrorCodes(parts);
  return classifyRouteFailure(codes, parts);
};

describe("friendRouteLogUtils classifyRouteFailure", () => {
  it("prioritizes onion proxy failures over missing route target", () => {
    const failure = classify(
      "onionRouter: forward_failed:no_route_target || onionRouter: forward_failed:proxy_unreachable"
    );
    expect(failure).toBe("onion-proxy-not-ready");
  });

  it("prioritizes direct channel readiness over missing route target", () => {
    const failure = classify(
      "onionRouter: forward_failed:no_route_target || directP2P: Direct P2P data channel is not open"
    );
    expect(failure).toBe("direct-channel-not-open");
  });

  it("keeps missing route target when it is the only route error", () => {
    const failure = classify("onionRouter: forward_failed:no_route_target");
    expect(failure).toBe("missing-route-target");
  });
});
