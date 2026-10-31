import { describe, test } from "vitest";
import { encodeBinaryTransportPacket } from "../adapters/transports/packetCodec";
import { encodeBase64Url } from "../security/base64url";

const payloads = [
  { label: "chat-1KiB", bytes: new Uint8Array(1024).fill(0x5a) },
  { label: "media-chunk-192KiB", bytes: new Uint8Array(192 * 1024).fill(0x5a) },
] as const;

describe.each(payloads)("transport encoding $label", ({ bytes }) => {
  test("legacy Base64 JSON", async ({ bench }) => {
    await bench("legacy Base64 JSON", () => {
      JSON.stringify({ id: "benchmark-message", payload: { b64: encodeBase64Url(bytes) } });
    }).run();
  });

  test("binary packet", async ({ bench }) => {
    await bench("binary packet", () => {
      encodeBinaryTransportPacket({ id: "benchmark-message", payload: bytes });
    }).run();
  });
});
