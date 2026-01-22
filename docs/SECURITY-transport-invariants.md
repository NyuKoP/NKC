# Transport Security Invariants

## Non-negotiable invariants
- Never claim Tor/Lokinet active unless proxy is reachable and address present.
- Forwarding must never return ok:true on failure.
- socks5h must use remote DNS (ATYP=0x03).
- Failover is allowed only in auto mode.
- Legacy local-only send does not leak to network.
- Hard timeouts and in-flight caps must be enforced.

## Tests that enforce invariants
- `src/main/__tests__/socksHttpClient.test.ts`
- `src/main/__tests__/onionController.send.test.ts`
- `src/main/__tests__/routePolicy.test.ts`
