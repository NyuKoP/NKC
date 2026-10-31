export const INLINE_MEDIA_MAX_BYTES = 500 * 1024 * 1024;

export const INLINE_MEDIA_CHUNK_SIZE = 1024 * 1024;

export const ONION_TRANSFER_MAX_BODY_BYTES = 2 * 1024 * 1024;

// The controller request contains a Base64 transport packet around the encrypted
// media envelope, so a 1 MiB plaintext chunk is about 2.5 MiB as JSON on the
// controller HTTP boundary. Keep the transport frame ceiling at 2 MiB, but give
// the local authenticated controller request its own bounded ceiling.
export const ONION_CONTROLLER_MAX_BODY_BYTES = 3 * 1024 * 1024;

export const ONION_CONTROLLER_MAX_BODY_BASE64_BYTES =
  4 * Math.ceil(ONION_CONTROLLER_MAX_BODY_BYTES / 3);
