import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, type AbortTraceEvent } from "../fetchWithTimeout";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps timeout abort to ABORTED_TIMEOUT and emits abort:fired", async () => {
    vi.useFakeTimers();
    const traces: AbortTraceEvent[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("AbortError"));
            },
            { once: true }
          );
        });
      }) as typeof fetch);

    const pending = fetchWithTimeout(
      "https://example.com/onion/inbox?deviceId=test-device",
      { method: "GET" },
      {
        timeoutMs: 50,
        opId: "/onion/inbox?deviceId=test-device",
        onTrace: (event) => traces.push(event),
      }
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "ABORTED_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(60);

    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      traces.some(
        (trace) =>
          trace.event === "abort:fired" &&
          trace.reason?.includes("fetch timeout 50ms")
      )
    ).toBe(true);
  });
});
