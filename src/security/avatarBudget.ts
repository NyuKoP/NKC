import { AVATAR_MAX_BYTES, detectSafePreviewMime, normalizeMediaMime } from "./mediaPolicy";

export const AVATAR_MAX_PIXELS = 4 * 1024 * 1024;

const dimensions = (bytes: Uint8Array, mime: string): [number, number] | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mime === "image/png") {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return;

    return [view.getUint32(16), view.getUint32(20)];
  }

  if (mime === "image/gif") {
    if (bytes.length < 13) return;

    return [view.getUint16(6, true), view.getUint16(8, true)];
  }

  if (mime === "image/webp") {
    if (bytes.length < 25) return;
    const codec = view.getUint32(12);

    if (codec === 0x56503858 && bytes.length >= 30 && view.getUint32(16, true) >= 10) {
      return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    }

    if (codec === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);

      if (bits >>> 29) return;

      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }

    if (codec === 0x56503820 && bytes.length >= 30 && !(bytes[20] & 1) && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }

    return;
  }

  if (mime !== "image/jpeg") return;
  let position = 2;

  while (position < bytes.length) {
    if (bytes[position++] !== 0xff) return;

    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];

    if (marker === 0xd9 || marker === 0xda || marker === undefined) return;

    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;

    if (position + 2 > bytes.length) return;
    const length = view.getUint16(position);

    if (length < 2 || position + length > bytes.length) return;

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return;

      return [view.getUint16(position + 5), view.getUint16(position + 3)];
    }

    position += length;
  }
};

// shortcut: Bounds the declared canvas; qualify per-frame and cumulative animation budgets separately.
export const assertAvatarPreviewBudget = async (image: Blob, mime: string) => {
  if (!Number.isInteger(image.size) || image.size <= 0 || image.size > AVATAR_MAX_BYTES) throw new Error("Invalid avatar image size");
  let bytes = new Uint8Array(await image.slice(0, 64).arrayBuffer());
  const normalized = normalizeMediaMime(mime);

  if (detectSafePreviewMime(bytes) !== normalized) throw new Error("Unsupported avatar image content");

  let size = dimensions(bytes, normalized);

  if (!size && normalized === "image/jpeg" && image.size > bytes.length) {
    bytes = new Uint8Array(await image.arrayBuffer());
    size = dimensions(bytes, normalized);
  }

  if (!size || size[0] <= 0 || size[1] <= 0 || size[0] > 4096 || size[1] > 4096 || size[0] * size[1] > AVATAR_MAX_PIXELS) {
    throw new Error("Avatar image exceeds preview dimensions");
  }
};
