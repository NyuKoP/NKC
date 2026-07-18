import { describe, expect, it } from "vitest";
import { selectRoute } from "../routePolicy";

const TOR_ONION = `${"a".repeat(56)}.onion`;
const LOKINET_ADDRESS = "peer.loki";

describe("routePolicy.selectRoute", () => {
  it("auto: lokinet then tor when both available", () => {
    const result = selectRoute("auto", { lokinet: LOKINET_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["lokinet", "tor"]);
  });

  it("auto: only tor when only tor provided", () => {
    const result = selectRoute("auto", { torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("preferLokinet: only lokinet", () => {
    const result = selectRoute("preferLokinet", { lokinet: LOKINET_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["lokinet"]);
  });

  it("preferTor: only tor", () => {
    const result = selectRoute("preferTor", { lokinet: LOKINET_ADDRESS, torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("manual: rejects multiple targets", () => {
    const result = selectRoute("manual", { lokinet: LOKINET_ADDRESS, torOnion: TOR_ONION });
    expect(result).toEqual([]);
  });

  it("manual: allows a single explicit target", () => {
    const result = selectRoute("manual", { torOnion: TOR_ONION });
    expect(result.map((item) => item.kind)).toEqual(["tor"]);
  });

  it("rejects non-overlay and path-injected targets", () => {
    expect(selectRoute("manual", { torOnion: "http://127.0.0.1" })).toEqual([]);
    expect(selectRoute("manual", { lokinet: "peer.loki/../../admin" })).toEqual([]);
  });
});
