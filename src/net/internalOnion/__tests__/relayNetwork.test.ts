import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportPacket } from "../../../adapters/transports/types";
import {
  __testResetRelayDeps,
  __testSetRelayDeps,
  __testToRelayPacket,
  handleIncomingRelayPacket,
  registerInternalOnionControlHandlers,
  sendControlPlaneMessage,
} from "../relayNetwork";
import { useInternalOnionRouteStore } from "../../../stores/internalOnionRouteStore";

describe("relayNetwork", () => {
  beforeEach(() => {
    __testResetRelayDeps();
    useInternalOnionRouteStore.getState().setRouteState({
      desiredHops: 2,
      establishedHops: 2,
      status: "ready",
      circuitId: "circuit-1",
      hops: [
        { hopIndex: 1, peerId: "relay-1", status: "ok" },
        { hopIndex: 2, peerId: "relay-2", status: "ok" },
      ],
      updatedAtTs: 1000,
    });
  });

  afterEach(() => {
    __testResetRelayDeps();
  });

  it("sends control-plane HELLO through the first relay", async () => {
    const sent: Array<{ to: string; envelope: unknown }> = [];
    __testSetRelayDeps({
      now: () => 1111,
      getLocalPeerId: () => "origin",
      sendRelayEnvelope: async (toPeerId, envelope) => {
        sent.push({ to: toPeerId, envelope });
      },
    });

    await sendControlPlaneMessage({
      type: "HOP_HELLO",
      circuitId: "circuit-1",
      hopIndex: 2,
      ts: 1111,
      senderPeerId: "origin",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("relay-1");
    expect(sent[0].envelope).toMatchObject({
      circuitId: "circuit-1",
      senderPeerId: "origin",
      chain: ["relay-1", "relay-2"],
      hopCursor: 0,
      payload: { kind: "control" },
    });
  });

  it("forwards non-final relay frame to next hop", async () => {
    const sent: Array<{ to: string; envelope: unknown }> = [];
    __testSetRelayDeps({
      now: () => 2222,
      getLocalPeerId: () => "relay-1",
      sendRelayEnvelope: async (toPeerId, envelope) => {
        sent.push({ to: toPeerId, envelope });
      },
    });

    const packet = __testToRelayPacket({
      type: "internal_onion_relay",
      v: 1,
      ts: 2220,
      circuitId: "circuit-1",
      senderPeerId: "origin",
      chain: ["relay-1", "relay-2", "target"],
      hopCursor: 0,
      payload: {
        kind: "data",
        packet: { id: "m1", payload: "hello" },
      },
    });

    const result = await handleIncomingRelayPacket(packet);
    expect(result.handled).toBe(true);
    expect(result.deliveredPacket).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("relay-2");
    expect(sent[0].envelope).toMatchObject({ hopCursor: 1 });
  });

  it("returns payload packet when final hop is reached", async () => {
    __testSetRelayDeps({
      now: () => 3333,
      getLocalPeerId: () => "target",
      sendRelayEnvelope: async () => {
        // no-op
      },
    });

    const innerPacket: TransportPacket = { id: "m2", payload: "ciphertext" };
    const packet = __testToRelayPacket({
      type: "internal_onion_relay",
      v: 1,
      ts: 3330,
      circuitId: "circuit-2",
      senderPeerId: "origin",
      chain: ["relay-1", "target"],
      hopCursor: 1,
      payload: {
        kind: "data",
        packet: innerPacket,
      },
    });

    const result = await handleIncomingRelayPacket(packet);
    expect(result.handled).toBe(true);
    expect(result.deliveredPacket).toEqual(innerPacket);
  });

  it("responds ACK for final HELLO and dispatches final ACK to handlers", async () => {
    const sent: Array<{ to: string; envelope: unknown }> = [];
    const ackHandler = vi.fn();
    registerInternalOnionControlHandlers({
      onAck: ackHandler,
      onPong: vi.fn(),
    });
    __testSetRelayDeps({
      now: () => 4444,
      getLocalPeerId: () => "relay-2",
      sendRelayEnvelope: async (toPeerId, envelope) => {
        sent.push({ to: toPeerId, envelope });
      },
    });

    const helloPacket = __testToRelayPacket({
      type: "internal_onion_relay",
      v: 1,
      ts: 4440,
      circuitId: "circuit-3",
      senderPeerId: "origin",
      chain: ["relay-1", "relay-2"],
      hopCursor: 1,
      payload: {
        kind: "control",
        message: {
          type: "HOP_HELLO",
          circuitId: "circuit-3",
          hopIndex: 2,
          ts: 4440,
          senderPeerId: "origin",
        },
      },
    });

    const helloResult = await handleIncomingRelayPacket(helloPacket);
    expect(helloResult.handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("origin");

    const ackPacket = __testToRelayPacket({
      type: "internal_onion_relay",
      v: 1,
      ts: 4450,
      circuitId: "circuit-3",
      senderPeerId: "relay-2",
      chain: ["relay-1"],
      hopCursor: 0,
      payload: {
        kind: "control",
        message: {
          type: "HOP_ACK",
          circuitId: "circuit-3",
          hopIndex: 2,
          ts: 4450,
          relayPeerId: "relay-2",
          ok: true,
        },
      },
    });

    __testSetRelayDeps({
      now: () => 4450,
      getLocalPeerId: () => "relay-1",
      sendRelayEnvelope: async () => {
        // no-op
      },
    });
    const ackResult = await handleIncomingRelayPacket(ackPacket);
    expect(ackResult.handled).toBe(true);
    expect(ackHandler).toHaveBeenCalledTimes(1);
  });
});

