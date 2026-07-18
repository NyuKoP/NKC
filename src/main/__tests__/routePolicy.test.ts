import { describe, expect, it } from "vitest";
import { selectRoute } from "../routePolicy";

const TOR_ONION = `${"a".repeat(56)}.onion`;
const alternateRoute_ADDRESS = "peer.loki";

describe("routePolicy.selectRoute", () => {
  it("auto: alternateRoute then tor when both available", () => {
    const result = selectRoute("auto", { alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["alternateRoute", "tor"]);
  });

  it("auto: only tor when only tor provided", () => {
    const result = selectRoute("auto", { torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("preferalternateRoute: only alternateRoute", () => {
    const result = selectRoute("preferalternateRoute", { alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["alternateRoute"]);
  });

  it("preferTor: only tor", () => {
    const result = selectRoute("preferTor", { alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("manual: rejects multiple targets", () => {
    const result = selectRoute("manual", { alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION });
    expect(result).toEqual([]);
  });

  it("manual: allows a single explicit target", () => {
    const result = selectRoute("manual", { torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("rejects non-overlay and path-injected targets", () => {
    expect(selectRoute("manual", { torOnion: "http://127.0.0.1" })).toEqual([]);
    expect(selectRoute("manual", { alternateRoute: "peer.loki/../../admin" })).toEqual([]);
  });
});
