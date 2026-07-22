import {
  INLINE_MEDIA_CHUNK_SIZE,
  INLINE_MEDIA_MAX_BYTES,
} from "../net/mediaTransferLimits";

export const MEDIA_FILENAME_MAX_LENGTH = 180;
export const MEDIA_MIME_MAX_LENGTH = 127;
export const MEDIA_OWNER_ID_MAX_LENGTH = 128;
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_MAX_CHUNKS = Math.ceil(
  INLINE_MEDIA_MAX_BYTES / (192 * 1024)
);

const SAFE_PREVIEW_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/ogg",
]);

const PREVIEW_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
};

const startsWithBytes = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length &&
  signature.every((value, index) => bytes[index] === value);

export const normalizeMediaMime = (value: unknown) => {
  if (typeof value !== "string") return "application/octet-stream";
  const normalized = value.trim().toLowerCase().split(";", 1)[0];
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized.length === 0 ||
    normalized.length > MEDIA_MIME_MAX_LENGTH ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
  ) {
    return "application/octet-stream";
  }
  return normalized;
};

export const isPreviewMediaClaim = (value: unknown) =>
  typeof value === "string" &&
  /^(?:image|video)\//i.test(value.trim());

export const isSafePreviewMime = (value: unknown) =>
  SAFE_PREVIEW_MIMES.has(normalizeMediaMime(value));

export const detectSafePreviewMime = (bytes: Uint8Array): string | null => {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWithBytes(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes.slice(4), [0x66, 0x74, 0x79, 0x70])
  ) {
    return "video/mp4";
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) return "video/ogg";
  return null;
};

export const hasValidPreviewSignature = (mime: unknown, bytes: Uint8Array) => {
  const normalized = normalizeMediaMime(mime);
  return isSafePreviewMime(normalized) && detectSafePreviewMime(bytes) === normalized;
};

export const sanitizeMediaFilename = (value: unknown) => {
  const candidate = typeof value === "string" ? value.normalize("NFC") : "";
  const sanitized = Array.from(candidate, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isBidiOverride =
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    return isControl || isBidiOverride || "\\/:*?\"<>|".includes(character)
      ? "_"
      : character;
  }).join("")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, MEDIA_FILENAME_MAX_LENGTH);
  return sanitized || "attachment";
};

export const canonicalizePreviewFilename = (value: unknown, mime: unknown) => {
  const normalizedMime = normalizeMediaMime(mime);
  const extension = PREVIEW_EXTENSIONS[normalizedMime];
  const sanitized = sanitizeMediaFilename(value);
  if (!extension) return sanitized;
  const lastDot = sanitized.lastIndexOf(".");
  const rawStem = lastDot > 0 ? sanitized.slice(0, lastDot) : sanitized;
  const stem = rawStem
    .replace(/\.+/g, "_")
    .replace(/^[-. ]+|[. ]+$/g, "")
    .slice(0, MEDIA_FILENAME_MAX_LENGTH - extension.length) || "media";
  return `${stem}${extension}`;
};

export const isValidMediaOwnerId = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MEDIA_OWNER_ID_MAX_LENGTH &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);

export type PreparedMediaMetadata = { mime: string; name: string };

export const inspectOutgoingMediaFile = async (file: File): Promise<PreparedMediaMetadata> => {
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > INLINE_MEDIA_MAX_BYTES) {
    throw new Error("Invalid media size");
  }
  const claimedMime = normalizeMediaMime(file.type);
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const detectedMime = detectSafePreviewMime(header);
  if (isPreviewMediaClaim(file.type)) {
    if (!detectedMime || detectedMime !== claimedMime) {
      throw new Error("Image or video content does not match its declared type");
    }
  }
  return {
    mime: detectedMime ?? claimedMime,
    name: detectedMime
      ? canonicalizePreviewFilename(file.name, detectedMime)
      : sanitizeMediaFilename(file.name),
  };
};

export const inspectAvatarImageFile = async (file: File): Promise<PreparedMediaMetadata> => {
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > AVATAR_MAX_BYTES) {
    throw new Error("Invalid avatar image size");
  }
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const detectedMime = detectSafePreviewMime(header);
  if (!detectedMime?.startsWith("image/")) {
    throw new Error("Unsupported avatar image content");
  }
  const claimedMime = normalizeMediaMime(file.type);
  if (isPreviewMediaClaim(file.type) && claimedMime !== detectedMime) {
    throw new Error("Avatar image content does not match its declared type");
  }
  return { mime: detectedMime, name: canonicalizePreviewFilename(file.name, detectedMime) };
};

export type ValidatedIncomingMediaRef = {
  ownerType: "message";
  ownerId: string;
  mime: string;
  total: number;
  chunkSize: number;
  name: string;
  size: number;
};

export const parseIncomingMediaRef = (
  value: unknown,
  expectedOwnerId?: string
): ValidatedIncomingMediaRef | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.ownerType !== "message" || !isValidMediaOwnerId(input.ownerId)) return null;
  if (expectedOwnerId && input.ownerId !== expectedOwnerId) return null;
  if (
    !Number.isInteger(input.chunkSize) ||
    Number(input.chunkSize) <= 0 ||
    Number(input.chunkSize) > INLINE_MEDIA_CHUNK_SIZE ||
    !Number.isInteger(input.size) ||
    Number(input.size) <= 0 ||
    Number(input.size) > INLINE_MEDIA_MAX_BYTES ||
    !Number.isInteger(input.total) ||
    Number(input.total) <= 0 ||
    Number(input.total) > MEDIA_MAX_CHUNKS
  ) {
    return null;
  }
  const chunkSize = Number(input.chunkSize);
  const size = Number(input.size);
  const total = Number(input.total);
  if (total !== Math.ceil(size / chunkSize)) return null;
  const mime = normalizeMediaMime(input.mime);
  if (isPreviewMediaClaim(input.mime) && !isSafePreviewMime(mime)) return null;
  return {
    ownerType: "message",
    ownerId: String(input.ownerId),
    mime,
    total,
    chunkSize,
    name: isSafePreviewMime(mime)
      ? canonicalizePreviewFilename(input.name, mime)
      : sanitizeMediaFilename(input.name),
    size,
  };
};
