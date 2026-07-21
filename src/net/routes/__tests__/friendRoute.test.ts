import { describe, expect, it, vi } from "vitest";
import { createFinalizeAttemptOnce, runFriendRouteAttempt } from "../friendRoute";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("friendRoute", () => {
  it("always finalizes within deadline", async () => {
    vi.useFakeTimers();
    const terminalWrites: Array<{ terminal_status: string; terminal_error_code: string | null }> = [];

    const attempt = runFriendRouteAttempt({
      deadlineMs: 300,
      onAttemptTerminal: (payload) => {
        terminalWrites.push({
          terminal_status: payload.terminal_status,
          terminal_error_code: payload.terminal_error_code,
        });
      },
      candidates: [
        {
          path: "onionRouter",
          run: async () => new Promise(() => {}),
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(301);
    const result = await attempt;
    vi.useRealTimers();

    expect(result.terminal_status).toBe("failed");
    expect(result.terminal_error_code).toBe("DEADLINE_EXCEEDED");
    expect(terminalWrites).toHaveLength(1);
  });

  it("finalizeAttemptOnce writes terminal state exactly once under races", async () => {
    const writeTerminal = vi.fn(async () => {});
    const finalize = createFinalizeAttemptOnce(writeTerminal, () => 1234);

    const [a, b] = await Promise.all([
      finalize("sent", null, "winner-a"),
      finalize("failed", "ROUTE_FAILED", "winner-b"),
    ]);

    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.terminal_status).toBe("sent");
  });

  it("aborts losing paths when first terminal success wins", async () => {
    let loserAborted = false;

    const result = await runFriendRouteAttempt({
      deadlineMs: 2000,
      onAttemptTerminal: async () => {},
      candidates: [
        {
          path: "directP2P",
          run: async () => {
            await wait(10);
            return { ok: true, via: "directP2P", details: "primary success" };
          },
        },
        {
          path: "onionRouter",
          run: async (signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  loserAborted = true;
                  resolve({ ok: false, code: "ABORTED" });
                },
                { once: true }
              );
            }),
        },
      ],
    });

    expect(result.terminal_status).toBe("sent");
    expect(result.via).toBe("directP2P");
    expect(loserAborted).toBe(true);
  });
});
