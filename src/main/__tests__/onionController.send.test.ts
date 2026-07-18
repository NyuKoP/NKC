import { describe, expect, it, vi } from "vitest";
import { handleOnionSend } from "../onionController";
import { selectRoute } from "../routePolicy";

const TOR_ONION = `${"a".repeat(56)}.onion`;
const alternateRoute_ADDRESS = "peer.loki";

const baseDeps = () => ({
  socksFetch: vi.fn(),
  selectRoute,
  now: () => 123456789,
  uuid: () => "msg-1",
  torProxyUrl: "socks5://127.0.0.1:9050",
  alternateRouteProxyUrl: "socks5://127.0.0.1:22000",
  storeLocal: vi.fn(),
});

describe("handleOnionSend routing", () => {
  it("auto: alternateRoute fails then tor succeeds", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockImplementation(async (url: string) => {
      if (url.includes(alternateRoute_ADDRESS)) {
        throw new Error("alternateRoute down");
      }
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    });
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "auto", alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION },
      },
      deps
    );
    expect(result.body.ok).toBe(true);
    expect(result.body.forwarded).toBe(true);
    expect("via" in result.body ? result.body.via : undefined).toBe("tor");
    expect(deps.socksFetch.mock.calls.map((call) => call[0])).toEqual([
      `http://${alternateRoute_ADDRESS}/onion/ingest`,
      `http://${TOR_ONION}/onion/ingest`,
    ]);
  });

  it("auto: alternateRoute success is not preempted by missing tor proxy offline queue", async () => {
    const deps = {
      ...baseDeps(),
      torProxyUrl: null,
      enqueueOfflineMessage: vi.fn(),
    };
    deps.socksFetch.mockResolvedValue({ status: 200, headers: {}, body: Buffer.alloc(0) });

    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "auto", alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION },
      },
      deps
    );

    expect(result.body.ok).toBe(true);
    expect(result.body.forwarded).toBe(true);
    expect("via" in result.body ? result.body.via : undefined).toBe("alternateRoute");
    expect(deps.enqueueOfflineMessage).not.toHaveBeenCalled();
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.socksFetch.mock.calls[0][0]).toBe(`http://${alternateRoute_ADDRESS}/onion/ingest`);
  });

  it("auto: queues tor onion only after all live route candidates fail", async () => {
    const deps = {
      ...baseDeps(),
      torProxyUrl: null,
      enqueueOfflineMessage: vi.fn(async () => undefined),
    };
    deps.socksFetch.mockRejectedValue(new Error("alternateRoute down"));

    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "auto", alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION },
      },
      deps
    );

    expect(result.status).toBe(202);
    expect(result.body.ok).toBe(true);
    expect("queued" in result.body ? result.body.queued : undefined).toBe(true);
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.enqueueOfflineMessage).toHaveBeenCalledWith({
      id: "msg-1",
      friendId: "peer-1",
      onionAddress: TOR_ONION,
      payload: "env",
      createdAt: 123456789,
    });
  });

  it("preferalternateRoute: fail does not try tor", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockRejectedValue(new Error("alternateRoute down"));
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "preferalternateRoute", alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION },
      },
      deps
    );
    expect(result.body.ok).toBe(false);
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.socksFetch.mock.calls[0][0]).toBe(`http://${alternateRoute_ADDRESS}/onion/ingest`);
  });

  it("preferTor: fail does not try alternateRoute", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockRejectedValue(new Error("tor down"));
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "preferTor", alternateRoute: alternateRoute_ADDRESS, torOnion: TOR_ONION },
      },
      deps
    );
    expect(result.body.ok).toBe(false);
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.socksFetch.mock.calls[0][0]).toBe(`http://${TOR_ONION}/onion/ingest`);
  });

  it("missing envelope returns ok:false", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend({ toDeviceId: "peer-1" }, deps);
    expect(result.body.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects arbitrary route targets before proxying", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "manual", torOnion: "http://127.0.0.1:8080" },
      },
      deps
    );
    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: "invalid-route-target" },
    });
    expect(deps.socksFetch).not.toHaveBeenCalled();
  });

  it("legacy payload stores locally and skips socks", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      { to: "local-peer", envelope: "env" },
      deps
    );
    expect(result.body.ok).toBe(true);
    expect(result.body.forwarded).toBe(false);
    expect(deps.socksFetch).not.toHaveBeenCalled();
    expect(deps.storeLocal).toHaveBeenCalledTimes(1);
  });

  it("fails when route target is missing for non-loopback send", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        fromDeviceId: "sender-1",
        envelope: "env",
      },
      deps
    );
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe("forward_failed:no_route_target");
    expect(deps.socksFetch).not.toHaveBeenCalled();
    expect(deps.storeLocal).not.toHaveBeenCalled();
  });

  it("allows explicit loopback send without route target", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend(
      {
        toDeviceId: "same-device",
        fromDeviceId: "same-device",
        envelope: "env",
      },
      deps
    );
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.forwarded).toBe(false);
    expect(deps.storeLocal).toHaveBeenCalledTimes(1);
  });
});
