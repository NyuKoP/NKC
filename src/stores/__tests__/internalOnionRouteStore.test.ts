import { beforeEach, describe, expect, it } from "vitest";
import {
  getHopsProgressText,
  getRouteStatusText,
  useInternalOnionRouteStore,
} from "../internalOnionRouteStore";

describe("internalOnionRouteStore", () => {
  beforeEach(() => {
    useInternalOnionRouteStore.getState().resetRouteState(3);
  });

  it("computes route status text for route states", () => {
    const store = useInternalOnionRouteStore.getState();
    store.patchRouteState({ status: "ready" });
    expect(getRouteStatusText(useInternalOnionRouteStore.getState().route, "ko")).toBe("경로: 연결됨");
    expect(getRouteStatusText(useInternalOnionRouteStore.getState().route, "en")).toBe(
      "Route: connected"
    );

    store.patchRouteState({ status: "degraded" });
    expect(getRouteStatusText(useInternalOnionRouteStore.getState().route, "ko")).toBe("경로: 불안정");

    store.patchRouteState({ status: "rebuilding" });
    expect(getRouteStatusText(useInternalOnionRouteStore.getState().route, "ko")).toBe(
      "경로: 재구성중"
    );
  });

  it("computes hops progress text", () => {
    const store = useInternalOnionRouteStore.getState();
    store.patchRouteState({
      desiredHops: 4,
      establishedHops: 2,
    });
    expect(getHopsProgressText(useInternalOnionRouteStore.getState().route)).toBe("hops: 2/4");
  });

  it("resizes hop list when desired hops changes", () => {
    const store = useInternalOnionRouteStore.getState();
    store.setDesiredHops(4);
    expect(useInternalOnionRouteStore.getState().route.hops).toHaveLength(4);
    store.setDesiredHops(3);
    expect(useInternalOnionRouteStore.getState().route.hops).toHaveLength(3);
  });
});
