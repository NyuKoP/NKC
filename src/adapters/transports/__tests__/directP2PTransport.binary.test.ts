import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBinaryTransportPacket } from "../packetCodec";
import { createDirectP2PTransport } from "../directP2PTransport";

class FakeDataChannel {
  readonly label: string;
  constructor(label: string) { this.label = label; }
  readyState: RTCDataChannelState = "open";
  binaryType: BinaryType = "blob";
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(value: string | ArrayBuffer) {
    this.sent.push(value);
  }

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  readonly channel = new FakeDataChannel("nkc-direct-v1");
  readonly fileChannel = new FakeDataChannel("nkc-file-v1");
  readonly channelOptions = new Map<string, RTCDataChannelInit>();
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channelOptions.set(label, options ?? {});
    return (label === "nkc-file-v1" ? this.fileChannel : this.channel) as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "test-offer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("direct P2P binary capability negotiation", () => {
  it("uses legacy JSON until the peer advertises binary packet support", async () => {
    const peerConnection = new FakePeerConnection();
    vi.stubGlobal("RTCPeerConnection", class {
      constructor() {
        return peerConnection;
      }
    });

    const transport = createDirectP2PTransport() as ReturnType<typeof createDirectP2PTransport> & {
      createOfferCode: () => Promise<string>;
    };
    await transport.createOfferCode();
    peerConnection.channel.onopen?.();

    await transport.send({ id: "legacy", payload: new Uint8Array([1, 2, 3]) });
    const legacy = JSON.parse(String(peerConnection.channel.sent[1])) as {
      payload: { b64: string };
    };
    expect(legacy.payload.b64).toBe("AQID");

    peerConnection.channel.onmessage?.({
      data: JSON.stringify({
        id: "__nkc_capabilities__",
        payload: "",
        capabilities: ["binary-packet-v1"],
      }),
    } as MessageEvent);
    await transport.send({ id: "binary", payload: new Uint8Array([4, 5, 6]) });

    const binary = peerConnection.channel.sent[2];
    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect(decodeBinaryTransportPacket(binary as ArrayBuffer)).toEqual({
      id: "binary",
      payload: new Uint8Array([4, 5, 6]),
    });
    expect(peerConnection.channelOptions.get("nkc-direct-v1")?.ordered).toBe(true);
    expect(peerConnection.channelOptions.get("nkc-file-v1")?.ordered).toBe(false);
  });

  it("sends file frames through the unordered binary channel", async () => {
    const peerConnection = new FakePeerConnection();
    vi.stubGlobal("RTCPeerConnection", class {
      constructor() { return peerConnection; }
    });
    const transport = createDirectP2PTransport();
    await transport.createOfferCode();
    const frame = Uint8Array.of(1, 2, 3, 4);
    await transport.sendFileFrame(frame);
    expect(new Uint8Array(peerConnection.fileChannel.sent[0] as ArrayBuffer)).toEqual(frame);
  });
});
