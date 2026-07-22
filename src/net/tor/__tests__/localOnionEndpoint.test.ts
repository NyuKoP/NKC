import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  awaitReady: vi.fn(async () => undefined),
}));

vi.mock("../TorRuntime", () => ({
  TorRuntime: { getInstance: () => runtime },
}));

import {
  __testResetPublishedLocalOnionEndpoint,
  ensureLocalOnionEndpoint,
  ensurePublishedLocalOnionEndpoint,
} from "../localOnionEndpoint";

const onionAddress = `${"a".repeat(56)}.onion`;

describe("ensurePublishedLocalOnionEndpoint", () => {
  beforeEach(() => {
    __testResetPublishedLocalOnionEndpoint();
    runtime.start.mockClear();
    runtime.awaitReady.mockClear();
  });

  it("returns the address only after its onion route is reachable", async () => {
    const prewarmOnionRoute = vi.fn(async () => ({ ok: true }));
    Object.assign(globalThis, {
      nkc: {
        ensureHiddenService: vi.fn(async () => ({ ok: true })),
        getMyOnionAddress: vi.fn(async () => onionAddress),
        prewarmOnionRoute,
      },
    });

    await expect(ensurePublishedLocalOnionEndpoint()).resolves.toBe(onionAddress);
    expect(prewarmOnionRoute).toHaveBeenCalledWith({ onionAddress });
  });

  it("returns a valid local address without waiting for publication probing", async () => {
    const prewarmOnionRoute = vi.fn(async () => ({ ok: true }));
    Object.assign(globalThis, {
      nkc: {
        ensureHiddenService: vi.fn(async () => ({ ok: true })),
        getMyOnionAddress: vi.fn(async () => onionAddress),
        prewarmOnionRoute,
      },
    });

    await expect(ensureLocalOnionEndpoint()).resolves.toBe(onionAddress);
    expect(prewarmOnionRoute).not.toHaveBeenCalled();
  });

  it("keeps the friend endpoint unavailable when publication probing fails", async () => {
    Object.assign(globalThis, {
      nkc: {
        ensureHiddenService: vi.fn(async () => ({ ok: true })),
        getMyOnionAddress: vi.fn(async () => onionAddress),
        prewarmOnionRoute: vi.fn(async () => ({ ok: false, error: "route-not-ready" })),
      },
    });

    await expect(ensurePublishedLocalOnionEndpoint()).resolves.toBeUndefined();
  });
});
