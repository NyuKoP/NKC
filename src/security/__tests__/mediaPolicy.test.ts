import { describe, expect, it } from "vitest";
import {
  canonicalizePreviewFilename,
  detectSafePreviewMime,
  hasValidPreviewSignature,
  parseIncomingMediaRef,
  sanitizeMediaFilename,
} from "../mediaPolicy";

const messageId = "550e8400-e29b-41d4-a716-446655440000";

describe("mediaPolicy", () => {
  it("accepts a valid 1 MiB-chunk message attachment manifest", () => {
    expect(parseIncomingMediaRef({
      ownerType: "message",
      ownerId: messageId,
      mime: "video/mp4",
      total: 2,
      chunkSize: 1024 * 1024,
      name: "clip.mp4",
      size: 1024 * 1024 + 17,
    }, messageId)).toMatchObject({
      ownerId: messageId,
      mime: "video/mp4",
      total: 2,
    });
  });

  it("rejects forged ownership and inconsistent chunk geometry", () => {
    const base = {
      ownerType: "message",
      ownerId: messageId,
      mime: "image/png",
      total: 1,
      chunkSize: 1024 * 1024,
      name: "photo.png",
      size: 16,
    };
    expect(parseIncomingMediaRef(base, "another-message")).toBeNull();
    expect(parseIncomingMediaRef({ ...base, total: 2 }, messageId)).toBeNull();
    expect(parseIncomingMediaRef({ ...base, chunkSize: 1024 * 1024 + 1 }, messageId)).toBeNull();
  });

  it("rejects active and unsupported preview MIME types", () => {
    const base = {
      ownerType: "message",
      ownerId: messageId,
      total: 1,
      chunkSize: 1024,
      name: "payload.svg",
      size: 100,
    };
    expect(parseIncomingMediaRef({ ...base, mime: "image/svg+xml" }, messageId)).toBeNull();
    expect(parseIncomingMediaRef({ ...base, mime: "video/quicktime" }, messageId)).toBeNull();
  });

  it("requires full, type-matching signatures for previews", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(detectSafePreviewMime(png)).toBe("image/png");
    expect(hasValidPreviewSignature("image/png", png)).toBe(true);
    expect(hasValidPreviewSignature("image/jpeg", png)).toBe(false);
    expect(hasValidPreviewSignature("image/png", html)).toBe(false);
  });

  it("removes path separators, controls, and bidi override characters from filenames", () => {
    expect(sanitizeMediaFilename("../secret\u202egnp.exe/clip.png")).toBe("_secret_gnp.exe_clip.png");
    expect(sanitizeMediaFilename("... ")).toBe("attachment");
  });

  it("replaces misleading and double extensions with the detected preview extension", () => {
    expect(canonicalizePreviewFilename("holiday.exe.png", "image/png"))
      .toBe("holiday_exe.png");
    expect(canonicalizePreviewFilename("clip.mp4.exe", "video/mp4"))
      .toBe("clip_mp4.mp4");
    expect(canonicalizePreviewFilename("notes.final.txt", "application/octet-stream"))
      .toBe("notes.final.txt");
  });
});
