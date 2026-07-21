const BINARY_STRING_CHUNK_SIZE = 0x8000;

const toBinaryString = (bytes: Uint8Array) => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BINARY_STRING_CHUNK_SIZE) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + BINARY_STRING_CHUNK_SIZE))
    );
  }
  return chunks.join("");
};

export const encodeBase64 = (bytes: Uint8Array) => btoa(toBinaryString(bytes));

export const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const encodeBase64Url = (bytes: Uint8Array) => {
  const base64 = encodeBase64(bytes);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return decodeBase64(padded);
};
