# Phase Lock: 4.7

Phase 4.7 internal system is LOCKED as the stability baseline.

## Locked modules and guarantees
- `src/main/socksHttpClient.ts`: SOCKS safety limits, timeout taxonomy, inflight cap, socks5h DNS.
- `src/main/onionController.ts`: forwarding error taxonomy; never ok:true on forward failure.
- `src/net/onionInboxClient.ts`: polling jitter/backoff with clean stop.
- `src/adapters/transports/onionRouterTransport.ts`: stable state transitions and recovery.
- `src/main/torManager.ts`: Tor lifecycle status and hidden service bootstrap.
- `src/main/lokinetManager.ts`: Lokinet lifecycle status and external proxy support.
- `src/main/routePolicy.ts`: routing mode semantics and strictness.
- `src/security/preferences.ts`: route/lokinet preference keys stability.
- `src/devices/devicePairing.ts`: rendezvous pairing API and dev-only BroadcastChannel fallback.

## Phase U begins
UI-only changes are allowed. Any changes to locked core modules require an explicit
phase bump documented here.

## Unlocked By
- Date: 2026-02-09
- Author: Codex
- Reason: Fix Tor onionRouter proxy recovery and stabilize route gating when multiple transports are prewarmed.
- Files: src/adapters/transports/onionRouterTransport.ts, src/net/router.ts
