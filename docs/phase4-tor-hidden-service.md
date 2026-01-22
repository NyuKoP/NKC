# Phase 4: Tor Hidden Service Transport

Phase 4 enables real onion inbound/outbound delivery by running Tor locally,
creating a hidden service, and forwarding envelopes through Tor SOCKS.

## What this enables
- A stable "My Onion Address" per device when Tor is running.
- Outbound delivery to a peer onion address via Tor SOCKS (real proxy).
- Store-and-forward inbox semantics remain unchanged.

## Hidden service creation
- Tor runs with a local DataDirectory under `appDataDir/nkc-tor`.
- A hidden service is created in `appDataDir/nkc-tor/hs-onion`.
- The hostname file provides the onion address.

## Requirements
- Tor must be available (bundled or system).
- Socks proxy must be running locally.

## Testing between two devices
1) On both devices, open Settings > Network.
2) Start Tor and create/refresh the onion address.
3) Exchange:
   - My Onion Address
   - Device ID
4) Send to the peer using (Onion Address + Device ID).
5) Verify delivery through `/onion/ingest` and inbox polling.

## Security notes
- Local controller is HTTP bound to 127.0.0.1 only.
- Envelopes are opaque here; app-layer encryption remains responsible.
