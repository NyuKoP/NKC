# Phase 3.5: Local Onion Controller (Main)

The controller is a minimal local HTTP server inside the Electron main process.
It binds to 127.0.0.1 only and stores envelopes in memory (store-and-forward).

## Endpoints
- GET `/onion/health`
  - `{ ok:true, network:"none"|"tor"|"lokinet", details?, socksProxy? }`
- POST `/onion/send`
  - `{ to, from?, envelope, ttlMs? }`
- GET `/onion/inbox?deviceId=<id>&after=<cursor>&limit=<n>`
  - `{ ok:true, items:[...], nextAfter:"<cursor>" }`
- POST `/onion/ingest`
  - `{ toDeviceId, from?, envelope, ts?, id? }`

## Behavior
- Stores messages by recipient deviceId in memory only.
- Cursor is a simple incrementing index string.
- TTL eviction runs every 60 seconds (default 7 days).
- Body size is limited to 256KB.

## Forwarding
- Best-effort HTTP forwarding via SOCKS proxy if configured.
- If proxy is not available, controller reports "local-only mode".
- Forwarding target is `${to}/onion/ingest` when `to` is a URL.

## Next steps
- Replace the local controller with a real Tor hidden service or lokinet router.
- Persist inbox storage for offline restarts.
