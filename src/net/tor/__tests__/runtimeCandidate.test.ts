import { describe, expect, it } from "vitest";
import { selectTorRuntimeCandidate, type TorRuntimeCandidate } from "../runtimeCandidate";

const candidate = (state: string): TorRuntimeCandidate => ({
  state,
  detail: null,
  socksUrl: state === "running" ? "socks5://127.0.0.1:9050" : null,
});

describe("selectTorRuntimeCandidate", () => {
  it("keeps the component idle state instead of a stale routing runtime", () => {
    expect(selectTorRuntimeCandidate(candidate("idle"), candidate("running"))?.state).toBe(
      "idle"
    );
  });

  it("uses the routing runtime only when the component bridge is unavailable", () => {
    expect(selectTorRuntimeCandidate(null, candidate("running"))?.state).toBe("running");
  });
});
