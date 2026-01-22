# Phase 4.5: Lokinet + Route Policy

Phase 4.5 adds Lokinet alongside Tor and introduces a route policy for outbound
messaging. The controller still treats envelopes as opaque strings.

## What this enables
- Devices can publish both Tor onion and Lokinet addresses.
- Sender chooses a route policy: auto, prefer Lokinet, prefer Tor, or manual.
- Outbound delivery uses real SOCKS proxy routing (Tor or Lokinet).

## Lokinet modes
- External mode (default):
  - Provide a SOCKS proxy URL and optional service address in Settings.
  - Status shows "running (unverified)" unless a probe is added.
- Embedded mode (best effort):
  - If a Lokinet binary exists, the app can start it and expose a local SOCKS proxy.

## Route policy behavior
- auto: try Lokinet first, then Tor if Lokinet fails.
- preferLokinet: only Lokinet; error if unavailable.
- preferTor: only Tor; error if unavailable.
- manual: use explicit target (no fallback).

## Testing between two devices
1) Configure Tor or Lokinet on both devices.
2) Exchange:
   - Tor onion address or Lokinet service address
   - Device ID
3) Set route policy and send using the chosen address + device ID.
4) Verify `/onion/ingest` is reachable through the selected proxy.

## Notes
- No DHT discovery is included.
- Local controller stays HTTP on 127.0.0.1 only.
