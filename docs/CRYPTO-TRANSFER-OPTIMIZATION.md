# File Transfer Crypto Optimization

This document describes the compatibility-preserving encryption optimizations applied after NKC v0.4.1. The network envelope remains the existing Base64/JSON format, so peers and stored media do not require a format migration.

## Processing model

```text
file chunk read
    -> prepared transfer crypto context
    -> warm envelope encryption worker
    -> bounded send window
    -> Tor or Direct P2P transport
```

- Files below 200 MiB use one encryption worker and one in-flight chunk.
- Files of at least 200 MiB use at most two workers and two in-flight chunks, matching the validated two-lane Tor policy.
- The per-conversation ratchet and envelope preparation remain serialized. For the two-lane path, the serialization gate is released only after ratchet advancement and authenticated envelope creation, allowing network forwarding to overlap safely.
- Worker startup failure falls back to renderer encryption without changing the wire format.

## Key handling

- The static X25519 shared secret is calculated once when deriving the legacy conversation key and ratchet base key. The derived values remain byte-for-byte compatible with the former independent derivations.
- DH private key and friend PSK buffers used during transfer setup are overwritten immediately after derivation.
- Conversation, ratchet, and identity-key copies are scoped to one file transfer and overwritten after all in-flight sends settle, including failure and cancellation paths.
- Worker-side key copies are overwritten after every encryption request.
- libsodium and the worker pool are prewarmed before the manifest and chunks are sent.

## Direct P2P safeguards

- The unordered file DataChannel retains its existing binary frame protocol.
- The recommended frame payload is capped at 64 KiB and reduced when the negotiated SCTP `maxMessageSize` is smaller.
- Frames larger than the negotiated SCTP maximum are rejected before `send()`.
- Both chat and file channels stop queueing when `bufferedAmount` exceeds 2 MiB and fail after a 10-second drain timeout.

## Compatibility and limits

- Base64/JSON encoding, envelope signatures, XChaCha20-Poly1305, and existing persisted media remain unchanged.
- This work reduces key setup overhead and renderer blocking. Tor circuit latency and bandwidth remain the dominant end-to-end transfer constraints.
- The worker has its own lazy-loaded libsodium runtime. This increases packaged assets but avoids loading the additional runtime until a file transfer starts.
- More than two concurrent encryption or Tor lanes is intentionally unsupported because the measured three-lane transfer was slower.

## Validation

- Conversation-key equivalence test
- Direct ordered/unordered DataChannel tests
- Negotiated SCTP frame-size rejection test
- Full Vitest suite: 227 passed, 4 skipped
- TypeScript and ESLint validation
- Native worker and production Vite/Electron build
- Git whitespace validation

The X25519 pair-derivation microbenchmark measured the combined derivation at approximately 2.05 times the throughput of two independent shared-secret calculations on the development host. This figure covers only the key-derivation portion, not total Tor transfer speed.
