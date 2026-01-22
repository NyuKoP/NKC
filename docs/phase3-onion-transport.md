# Phase 3: Onion Transport (Renderer)

This phase wires the onionRouter transport to a local controller using
store-and-forward inbox polling.

## What it does
- Sends TransportPacket envelopes to a local controller over HTTP.
- Polls `/onion/inbox` every second and dispatches new packets.
- Dedupes by message id (last 500 ids).
- Reports transport state: connecting, connected, degraded, failed.

## Envelope format
- Envelope is base64url(JSON.stringify(packet)).
- Controller treats the envelope as an opaque string.

## Local-only test
1) Run two app instances on the same machine.
2) Ensure both use the same Local Onion Controller URL.
3) Use the recipient deviceId as the `to` field in the packet metadata.
4) Send a message; the other instance should receive it on the next poll.

## Notes
- Poll failures: 3 consecutive failures -> degraded, 6 -> failed.
- Offline delivery works because the controller stores messages in memory.
