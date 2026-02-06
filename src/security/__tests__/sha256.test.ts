import { describe, expect, it } from "vitest";
import { sha256 } from "../sha256";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("sha256", () => {
  it("matches empty input vector", () => {
    expect(toHex(sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("matches ascii vector", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(toHex(sha256(bytes))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
