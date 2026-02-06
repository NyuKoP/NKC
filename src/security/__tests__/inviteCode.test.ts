import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../base64url";
import { decodeInviteCodeV1, encodeInviteCodeV1 } from "../inviteCode";
import { canonicalBytes } from "../../crypto/canonicalJson";

const makeBytes = (seed: number) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i) % 256;
  return out;
};

const makeInviteCode = (seed = 9) =>
  encodeInviteCodeV1({
    v: 1,
    friend: {
      v: 1,
      identityPub: encodeBase64Url(makeBytes(seed)),
      dhPub: encodeBase64Url(makeBytes(seed + 31)),
      deviceId: "123e4567-e89b-42d3-a456-426614174000",
    },
    psk: encodeBase64Url(makeBytes(seed + 63)),
  });

const makeInviteCodeWithDashInBody = () => {
  for (let seed = 1; seed < 300; seed += 1) {
    const code = makeInviteCode(seed);
    if (code.slice("NKI1-".length).includes("-")) return code;
  }
  throw new Error("failed to build test invite code with '-' in body");
};

const legacyHash32Bytes = (bytes: Uint8Array) => {
  const seeds = [
    0x811c9dc5, 0x01000193, 0x1234567, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    0x27d4eb2f, 0x165667b1,
  ];
  const out = new Uint8Array(seeds.length * 4);
  seeds.forEach((seed, idx) => {
    let hash = seed >>> 0;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    const offset = idx * 4;
    out[offset] = (hash >>> 24) & 0xff;
    out[offset + 1] = (hash >>> 16) & 0xff;
    out[offset + 2] = (hash >>> 8) & 0xff;
    out[offset + 3] = hash & 0xff;
  });
  return out;
};


describe("inviteCode", () => {
  it("decodes valid invite code", () => {
    const decoded = decodeInviteCodeV1(makeInviteCode());
    expect("error" in decoded ? decoded.error : "").toBe("");
  });

  it("decodes invite code with common paste noise", () => {
    const noisy = `"${makeInviteCode()}:"`;
    const decoded = decodeInviteCodeV1(noisy);
    expect("error" in decoded ? decoded.error : "").toBe("");
  });

  it("decodes invite code with zero-width separators", () => {
    const code = makeInviteCode();
    const withZeroWidth = `${code.slice(0, 7)}\u200b${code.slice(7)}`;
    const decoded = decodeInviteCodeV1(withZeroWidth);
    expect("error" in decoded ? decoded.error : "").toBe("");
  });

  it("decodes invite code when base64url body includes '-'", () => {
    const decoded = decodeInviteCodeV1(makeInviteCodeWithDashInBody());
    expect("error" in decoded ? decoded.error : "").toBe("");
  });

  it("ignores invalid friend deviceId in invite payload", () => {
    const code = encodeInviteCodeV1({
      v: 1,
      friend: {
        v: 1,
        identityPub: encodeBase64Url(makeBytes(41)),
        dhPub: encodeBase64Url(makeBytes(73)),
        deviceId: "legacy-device-id",
      },
      psk: encodeBase64Url(makeBytes(101)),
    });
    const decoded = decodeInviteCodeV1(code);
    expect("error" in decoded ? decoded.error : "").toBe("");
    if (!("error" in decoded)) {
      expect(decoded.friend.deviceId).toBeUndefined();
    }
  });

  it("accepts legacy checksum invite code", () => {
    const payload = {
      v: 1 as const,
      friend: {
        v: 1 as const,
        identityPub: encodeBase64Url(makeBytes(17)),
        dhPub: encodeBase64Url(makeBytes(57)),
        deviceId: "123e4567-e89b-42d3-a456-426614174000",
      },
      psk: encodeBase64Url(makeBytes(97)),
    };
    const payloadBytes = canonicalBytes(payload);
    const checksum = legacyHash32Bytes(payloadBytes).slice(0, 4);
    const combined = new Uint8Array(payloadBytes.length + checksum.length);
    combined.set(payloadBytes, 0);
    combined.set(checksum, payloadBytes.length);
    const code = `NKI1-${encodeBase64Url(combined)}`;
    const decoded = decodeInviteCodeV1(code);
    expect("error" in decoded ? decoded.error : "").toBe("");
  });
});
