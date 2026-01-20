import { describe, expect, it } from "vitest";
import { decryptJsonRecord, encryptJsonRecord } from "../vault";
import { getSodium } from "../../security/sodium";

describe("vault envelope validation", () => {
  it("rejects invalid envelope encoding before decrypt", async () => {
    const sodium = await getSodium();
    const vk = sodium.randombytes_buf(32);
    const samples = ["", "%%%", "not-base64!"];

    for (const value of samples) {
      try {
        await decryptJsonRecord(vk, "id1", "profile", value);
        throw new Error("Expected decrypt to fail");
      } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error);
        expect(message).toMatch(/Invalid vault envelope/);
        expect(message).not.toMatch(/ciphertext/i);
      }
    }
  });

  it("round-trips encrypted records", async () => {
    const sodium = await getSodium();
    const vk = sodium.randombytes_buf(32);
    const enc = await encryptJsonRecord(vk, "id1", "profile", { a: 1 });
    const out = await decryptJsonRecord(vk, "id1", "profile", enc);
    expect(out).toEqual({ a: 1 });
  });

  it("fails on AAD mismatch", async () => {
    const sodium = await getSodium();
    const vk = sodium.randombytes_buf(32);
    const enc = await encryptJsonRecord(vk, "id1", "profile", { a: 1 });
    await expect(decryptJsonRecord(vk, "id2", "profile", enc)).rejects.toThrow(
      "AAD mismatch"
    );
  });
});
