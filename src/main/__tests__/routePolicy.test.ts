import { describe, expect, it } from "vitest";
import { selectRoute } from "../routePolicy";

describe("routePolicy.selectRoute", () => {
  it("auto: alternateRoute then tor when both available", () => {
    const result = selectRoute("auto", { alternateRoute: "alternateRoute.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["alternateRoute", "tor"]);
  });

  it("auto: only tor when only tor provided", () => {
    const result = selectRoute("auto", { torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("preferalternateRoute: only alternateRoute", () => {
    const result = selectRoute("preferalternateRoute", { alternateRoute: "alternateRoute.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["alternateRoute"]);
  });

  it("preferTor: only tor", () => {
    const result = selectRoute("preferTor", { alternateRoute: "alternateRoute.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("manual: uses explicit priority (alternateRoute then tor)", () => {
    const result = selectRoute("manual", { alternateRoute: "alternateRoute.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["alternateRoute"]);
  });
});
