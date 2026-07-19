# Transport and Routing Architecture

## Transport options
- Direct: WebRTC data channel for same-network/direct signaling.
- Onion: Tor hidden service via local controller store-and-forward.
- Lokinet: outbound proxy routing via SOCKS proxy.
- Future: optional libp2p for discovery/relay (not in Phase 4.6).

## Route policy and failover
- Modes: auto, preferLokinet, preferTor, manual.
- auto: try Lokinet then Tor when both targets exist.
- preferLokinet/preferTor: single-path, no fallback.
- manual: explicit single target only.

## Legacy vs network routing
- Legacy local-only: `/onion/send` without route targets stores locally only.
- Network route: `/onion/send` with tor/lokinet targets forwards through proxies.

## Controller contract
- `GET /onion/health`: status summary for Tor/Lokinet proxies.
- `POST /onion/send`: legacy local-only or routed forwarding.
- `POST /onion/ingest`: receive envelope into inbox.
- `GET /onion/inbox`: poll inbox items.
- `GET /onion/address`: return published Tor/Lokinet addresses.

## Native transport boundary
- Electron keeps the authenticated loopback HTTP boundary, local inbox, IPC, and diagnostic event publication.
- The Go worker owns route validation, Lokinet/Tor failover, SOCKS5 negotiation, optional username/password authentication, HTTP/HTTPS requests, bounded concurrency, retries, response-size enforcement, reusable connection pools, and failure queueing.
- Electron communicates with the worker through `transport.fetch` and `transport.clearProxy`; payload bytes are Base64-encoded only at this control boundary.
- Routed `/onion/send` requests use `transport.forward`; successful and failed route events are returned to Electron for the existing diagnostic sinks.
- The worker never follows HTTP redirects automatically, preventing an onion or Lokinet destination from redirecting a request to an unintended network target.
- Offline queue delivery and interactive forwarding share the same Go SOCKS dialer so protocol validation remains consistent.

## Error taxonomy
Forwarding errors normalize to:
- timeout
- proxy_unreachable
- handshake_failed
- upstream_error
