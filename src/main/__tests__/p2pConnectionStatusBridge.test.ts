import { describe, expect, it, vi } from "vitest";
import {
  createP2PMainStatePublisher,
  P2P_CONNECTION_STATUS_CHANNEL,
  type BrowserWindowLike,
} from "../p2pConnectionStatusBridge";

describe("createP2PMainStatePublisher", () => {
  it("broadcasts connection status payloads to live windows", () => {
    const liveSend = vi.fn();
    const closedSend = vi.fn();
    const windows: BrowserWindowLike[] = [
      { webContents: { send: liveSend } },
      { webContents: { isDestroyed: () => true, send: closedSend } },
    ];
    const publish = createP2PMainStatePublisher(() => windows, () => 42);

    publish("conv-1", "reconnecting", "pong-timeout");

    expect(liveSend).toHaveBeenCalledWith(P2P_CONNECTION_STATUS_CHANNEL, {
      convId: "conv-1",
      state: "reconnecting",
      detail: "pong-timeout",
      changedAt: 42,
    });
    expect(closedSend).not.toHaveBeenCalled();
  });
});
