import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../../security/base64url";
import { normalizePayload } from "../directTransport";
import type { TransportPacket } from "../../adapters/transports/types";

describe("directTransport.normalizePayload", () => {
  it("restores bytes from b64 wrapper", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253, 254, 255]);
    const wrapped = { b64: encodeBase64Url(bytes) };
    const out = normalizePayload(wrapped);
    expect(out).not.toBeNull();
    expect(Array.from(out ?? [])).toEqual(Array.from(bytes));
  });

  it("returns null for invalid b64", () => {
    const out = normalizePayload({ b64: "!!!!" } as TransportPacket["payload"]);
    expect(out).toBeNull();
  });

  it("returns null when b64 is not a string", () => {
    const out = normalizePayload({ b64: 123 } as TransportPacket["payload"]);
    expect(out).toBeNull();
  });
});
