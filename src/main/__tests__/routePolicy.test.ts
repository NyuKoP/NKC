import { describe, expect, it } from "vitest";
import { selectRoute } from "../routePolicy";

describe("routePolicy.selectRoute", () => {
  it("auto: lokinet then tor when both available", () => {
    const result = selectRoute("auto", { lokinet: "lokinet.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["lokinet", "tor"]);
  });

  it("auto: only tor when only tor provided", () => {
    const result = selectRoute("auto", { torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("preferLokinet: only lokinet", () => {
    const result = selectRoute("preferLokinet", { lokinet: "lokinet.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["lokinet"]);
  });

  it("preferTor: only tor", () => {
    const result = selectRoute("preferTor", { lokinet: "lokinet.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("manual: uses explicit priority (lokinet then tor)", () => {
    const result = selectRoute("manual", { lokinet: "lokinet.example", torOnion: "abc.onion" });
    expect(result.map((item) => item.kind)).toEqual(["lokinet"]);
  });
});
