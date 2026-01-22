import { describe, expect, it, vi } from "vitest";
import { handleOnionSend } from "../onionController";
import { selectRoute } from "../routePolicy";

const baseDeps = () => ({
  socksFetch: vi.fn(),
  selectRoute,
  now: () => 123456789,
  uuid: () => "msg-1",
  torProxyUrl: "socks5://127.0.0.1:9050",
  lokinetProxyUrl: "socks5://127.0.0.1:22000",
  storeLocal: vi.fn(),
});

describe("handleOnionSend routing", () => {
  it("auto: lokinet fails then tor succeeds", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockImplementation(async (url: string) => {
      if (url.includes("lokinet")) {
        throw new Error("lokinet down");
      }
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    });
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "auto", lokinet: "lokinet.test", torOnion: "abc.onion" },
      },
      deps
    );
    expect(result.body.ok).toBe(true);
    expect(result.body.forwarded).toBe(true);
    expect(result.body.via).toBe("tor");
    expect(deps.socksFetch.mock.calls.map((call) => call[0])).toEqual([
      "http://lokinet.test/onion/ingest",
      "http://abc.onion/onion/ingest",
    ]);
  });

  it("preferLokinet: fail does not try tor", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockRejectedValue(new Error("lokinet down"));
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "preferLokinet", lokinet: "lokinet.test", torOnion: "abc.onion" },
      },
      deps
    );
    expect(result.body.ok).toBe(false);
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.socksFetch.mock.calls[0][0]).toBe("http://lokinet.test/onion/ingest");
  });

  it("preferTor: fail does not try lokinet", async () => {
    const deps = baseDeps();
    deps.socksFetch.mockRejectedValue(new Error("tor down"));
    const result = await handleOnionSend(
      {
        toDeviceId: "peer-1",
        envelope: "env",
        route: { mode: "preferTor", lokinet: "lokinet.test", torOnion: "abc.onion" },
      },
      deps
    );
    expect(result.body.ok).toBe(false);
    expect(deps.socksFetch).toHaveBeenCalledTimes(1);
    expect(deps.socksFetch.mock.calls[0][0]).toBe("http://abc.onion/onion/ingest");
  });

  it("missing envelope returns ok:false", async () => {
    const deps = baseDeps();
    const result = await handleOnionSend({ toDeviceId: "peer-1" }, deps);
    expect(result.body.ok).toBe(false);
    expect(result.status).toBe(400);
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
});
