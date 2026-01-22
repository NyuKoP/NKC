# Phase 4.5: alternateRoute + Route Policy

Phase 4.5 adds alternateRoute alongside Tor and introduces a route policy for outbound
messaging. The controller still treats envelopes as opaque strings.

## What this enables
- Devices can publish both Tor onion and alternateRoute addresses.
- Sender chooses a route policy: auto, prefer alternateRoute, prefer Tor, or manual.
- Outbound delivery uses real SOCKS proxy routing (Tor or alternateRoute).

## alternateRoute modes
- External mode (default):
  - Provide a SOCKS proxy URL and optional service address in Settings.
  - Status shows "running (unverified)" unless a probe is added.
- Embedded mode (best effort):
  - If a alternateRoute binary exists, the app can start it and expose a local SOCKS proxy.

## Route policy behavior
- auto: try alternateRoute first, then Tor if alternateRoute fails.
- preferalternateRoute: only alternateRoute; error if unavailable.
- preferTor: only Tor; error if unavailable.
- manual: use explicit target (no fallback).

## Testing between two devices
1) Configure Tor or alternateRoute on both devices.
2) Exchange:
   - Tor onion address or alternateRoute service address
   - Device ID
3) Set route policy and send using the chosen address + device ID.
4) Verify `/onion/ingest` is reachable through the selected proxy.

## Notes
- No DHT discovery is included.
- Local controller stays HTTP on 127.0.0.1 only.
