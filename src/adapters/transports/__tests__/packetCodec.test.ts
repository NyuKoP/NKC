import { describe, expect, it } from "vitest";
import {
  decodeBinaryTransportPacket,
  encodeBinaryTransportPacket,
  isBinaryTransportPacket,
} from "../packetCodec";

describe("binary transport packet codec", () => {
  it("round-trips binary payloads and routing metadata", () => {
    const encoded = encodeBinaryTransportPacket({
      id: "message-1",
      payload: new Uint8Array([0, 1, 2, 253, 254, 255]),
      route: { torOnion: "peer.onion" },
      toDeviceId: "device-2",
    } as never);

    expect(encoded).not.toBeNull();
    expect(isBinaryTransportPacket(encoded!)).toBe(true);
    expect(decodeBinaryTransportPacket(encoded!)).toEqual({
      id: "message-1",
      payload: new Uint8Array([0, 1, 2, 253, 254, 255]),
      route: { torOnion: "peer.onion" },
      toDeviceId: "device-2",
    });
  });

  it("keeps legacy non-binary payloads on the JSON path", () => {
    expect(
      encodeBinaryTransportPacket({ id: "legacy", payload: { b64: "AQID" } })
    ).toBeNull();
  });

  it("rejects truncated and malformed frames", () => {
    const encoded = encodeBinaryTransportPacket({
      id: "message-1",
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(decodeBinaryTransportPacket(encoded!.subarray(0, 7))).toBeNull();

    const corrupted = encoded!.slice();
    new DataView(corrupted.buffer).setUint32(5, 0xffff, false);
    expect(decodeBinaryTransportPacket(corrupted)).toBeNull();
  });
});
