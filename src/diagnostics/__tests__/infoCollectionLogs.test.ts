import { describe, expect, it } from "vitest";
import { sanitizeInfoLogPayload } from "../infoCollectionLogs";
import { createSafeConsole } from "../safeConsole";

describe("info collection log privacy", () => {
  it("redacts routing identifiers and secrets recursively", () => {
    const onion = `${"a".repeat(56)}.onion`;
    const sanitized = sanitizeInfoLogPayload({
      destination: `http://${onion}`,
      toDeviceId: "device-secret",
      primaryDeviceId: "primary-device-secret",
      friendIdHash: "not-actually-a-hash",
      context: {
        friendCode: "NKC1-secret_code",
        request: `/onion/inbox?deviceId=device-secret&after=1`,
        peer: `connecting to ${onion} through 127.0.0.1`,
      },
    });

    expect(sanitized).toEqual({
      destination: "[redacted]",
      toDeviceId: "[redacted]",
      primaryDeviceId: "[redacted]",
      friendIdHash: "[redacted]",
      context: {
        friendCode: "[redacted]",
        request: "/onion/inbox?deviceId=[redacted]&after=1",
        peer: "connecting to [onion-redacted] through [ip-redacted]",
      },
    });
  });

  it("removes error messages, paths, and identifiers from direct console arguments", () => {
    const calls: unknown[][] = [];
    const target = {
      debug: (...args: unknown[]) => calls.push(args),
      info: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(args),
      error: (...args: unknown[]) => calls.push(args),
      log: (...args: unknown[]) => calls.push(args),
    } as Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
    const logger = createSafeConsole(target);
    logger.warn(
      "failed convId=conversation-secret",
      Object.assign(new Error("C:\\Users\\person\\secret"), { code: "EFAIL" })
    );
    expect(calls).toEqual([
      [
        "failed convId=[redacted]",
        JSON.stringify({ name: "Error", message: "[path-redacted]", code: "EFAIL" }),
      ],
    ]);
  });
});
