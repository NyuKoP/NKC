import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../base64url";
import { decodeInviteCodeV1, encodeInviteCodeV1 } from "../inviteCode";

const makeBytes = (seed: number) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i) % 256;
  return out;
};

describe("inviteCode", () => {
  it("preserves friend deviceId when decoding", () => {
    const code = encodeInviteCodeV1({
      v: 1,
      friend: {
        v: 1,
        identityPub: encodeBase64Url(makeBytes(1)),
        dhPub: encodeBase64Url(makeBytes(33)),
        deviceId: "123e4567-e89b-42d3-a456-426614174000",
      },
      psk: encodeBase64Url(makeBytes(99)),
    });

    const decoded = decodeInviteCodeV1(code);
    if ("error" in decoded) {
      throw new Error(decoded.error);
    }
    expect(decoded.friend.deviceId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("rejects invalid friend deviceId in invite payload", () => {
    const code = encodeInviteCodeV1({
      v: 1,
      friend: {
        v: 1,
        identityPub: encodeBase64Url(makeBytes(2)),
        dhPub: encodeBase64Url(makeBytes(44)),
        deviceId: "not-a-uuid",
      },
      psk: encodeBase64Url(makeBytes(120)),
    });

    const decoded = decodeInviteCodeV1(code);
    expect("error" in decoded ? decoded.error : "").toBe("Invalid deviceId in invite code.");
  });

  it("requires 32-byte PSK", () => {
    const code = encodeInviteCodeV1({
      v: 1,
      friend: {
        v: 1,
        identityPub: encodeBase64Url(makeBytes(7)),
        dhPub: encodeBase64Url(makeBytes(77)),
      },
      psk: encodeBase64Url(new Uint8Array([1, 2, 3])),
    });
    const decoded = decodeInviteCodeV1(code);
    expect("error" in decoded ? decoded.error : "").toBe("Invalid PSK length in invite code.");
  });
});
