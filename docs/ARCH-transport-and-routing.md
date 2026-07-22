# Transport and Routing Architecture

## Transport options
- Direct: WebRTC data channel for same-network/direct signaling.
- Onion: Tor hidden service via local controller store-and-forward.
- Future: optional libp2p for discovery/relay (not in Phase 4.6).

## Route policy and failover
- Modes: auto, preferTor, manual.
- auto/preferTor: use the peer's Tor Onion target.
- manual: explicit single target only.

## Legacy vs network routing
- Legacy local-only: `/onion/send` without route targets stores locally only.
- Network route: `/onion/send` with a Tor Onion target forwards through the Tor SOCKS proxy.

## Controller contract
- `GET /onion/health`: status summary for the Tor proxy.
- `POST /onion/send`: legacy local-only or routed forwarding.
- `POST /onion/ingest`: receive envelope into inbox.
- `GET /onion/inbox`: poll inbox items.
- `GET /onion/address`: return the published Tor Onion address.

The authenticated loopback controller accepts request bodies up to 2 MiB. The Go transport and offline queue enforce the same ceiling, and the renderer drops oversized incoming frames before dispatch. Per-device and global inbox byte/item limits remain separate safeguards.

## Native transport boundary
- Electron keeps the authenticated loopback HTTP boundary, local inbox, IPC, and diagnostic event publication.
- The Go worker owns Tor route validation, SOCKS5 negotiation, optional username/password authentication, HTTP requests, bounded concurrency, retries, response-size enforcement, reusable connection pools, and failure queueing.
- Electron communicates with the worker through a length-prefixed binary stdio protocol; bulk payload bytes are not Base64-expanded.
- Routed `/onion/send` requests use `transport.forward`; successful and failed route events are returned to Electron for the existing diagnostic sinks.
- The worker never follows HTTP redirects automatically, preventing an Onion destination from redirecting a request to an unintended network target.
- Offline queue delivery and interactive forwarding share the same Go SOCKS dialer so protocol validation remains consistent.

## Large file data path

- Files are read and encrypted incrementally in 1 MiB plaintext chunks; the complete file is not Base64-expanded in memory.
- Each chunk is an independently authenticated media envelope with its file owner, index, total count, declared size, MIME type, and chunk size.
- The 2 MiB request/frame ceiling accommodates the encrypted and Base64-encoded form of a 1 MiB chunk while keeping allocation and queue sizes bounded.
- The receiving side deduplicates event identifiers, verifies signatures before decryption, restores chunk order, and validates complete-file byte accounting or SHA-256 in live tests.
- Tor delivery uses reusable Go HTTP/SOCKS connections. The live soak sends one large chunk at a time because high parallelism on a single Tor circuit caused upstream response timeouts; application responsiveness is verified with reverse chat during transfer.
- Proxy interruption does not relax routing policy. The route is re-established before transfer resumes, and failed deliveries remain subject to bounded queue retries.

See [Large File Transfer](LARGE-FILE-TRANSFER.md) for commands and measurements.

## Error taxonomy
Forwarding errors normalize to:
- timeout
- proxy_unreachable
- handshake_failed
- upstream_error
