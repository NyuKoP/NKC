import { describe, expect, it, vi } from "vitest";
import { handleOnionSend } from "../onionController";

const baseDeps = () => ({
  now: () => 123456789,
  uuid: () => "msg-local",
  storeLocal: vi.fn(),
  forwardRouted: vi.fn(async () => ({
    status: 200,
    body: { ok: true, msgId: "msg-go", forwarded: true, via: "tor" },
    traces: [{ event: "onionController:forward:ok", routeKind: "tor" }],
  })),
  emitTrace: vi.fn(),
});

describe("handleOnionSend Go routing boundary", () => {
  it("delegates routed delivery and trace events to the Go worker adapter", async () => {
    const deps = baseDeps();
    const payload = {
      toDeviceId: "peer-1",
      envelope: "ciphertext",
      route: { mode: "preferTor" as const, torOnion: `${"a".repeat(56)}.onion` },
    };

    const result = await handleOnionSend(payload, deps);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, msgId: "msg-go", forwarded: true, via: "tor" },
    });
    expect(deps.forwardRouted).toHaveBeenCalledWith(payload);
    expect(deps.emitTrace).toHaveBeenCalledWith({
      event: "onionController:forward:ok",
      routeKind: "tor",
    });
    expect(deps.storeLocal).not.toHaveBeenCalled();
  });

  it("keeps explicit loopback storage in the local controller", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      { toDeviceId: "same-device", fromDeviceId: "same-device", envelope: "ciphertext" },
      deps
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, msgId: "msg-local", forwarded: false },
    });
    expect(deps.storeLocal).toHaveBeenCalledTimes(1);
    expect(deps.forwardRouted).not.toHaveBeenCalled();
  });

  it("blocks non-loopback sends without a route target", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      { toDeviceId: "peer-1", fromDeviceId: "sender-1", envelope: "ciphertext" },
      deps
    );
    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: "forward_failed:no_route_target" },
    });
    expect(deps.storeLocal).not.toHaveBeenCalled();
    expect(deps.forwardRouted).not.toHaveBeenCalled();
  });

  it("fails closed when the native routing boundary is unavailable", async () => {
    const deps = baseDeps();
    const withoutNative = { ...deps, forwardRouted: undefined };
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "ciphertext",
        route: { mode: "preferTor", torOnion: `${"a".repeat(56)}.onion` },
      },
      withoutNative
    );
    expect(result).toEqual({
      status: 502,
      body: { ok: false, error: "forward_failed:native_transport_unavailable" },
    });
  });

  it("returns a bounded error response when native forwarding rejects", async () => {
    const deps = baseDeps();
    deps.forwardRouted.mockRejectedValueOnce(new Error("native_worker_header_too_large"));
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "ciphertext",
        route: { mode: "manual", torOnion: `${"a".repeat(56)}.onion` },
      },
      deps
    );
    expect(result).toEqual({
      status: 502,
      body: { ok: false, error: "forward_failed:native_transport_error" },
    });
  });
});
