# Large File Transfer

This document describes the current bounded-memory file-transfer path and the tests used to validate it. NKC accepts inline files up to 500 MiB.

## Data flow

1. The renderer reads a file incrementally in 1 MiB plaintext chunks.
2. Each chunk is encrypted and signed as an independent media envelope.
3. The authenticated Electron loopback controller forwards the envelope through the Go worker.
4. The worker reuses its HTTP client and SOCKS tunnel for the destination proxy and applies bounded retry/queue policy.
5. The receiver verifies the envelope, rejects duplicate event identifiers, decrypts the chunk, and stores it by index.
6. File reconstruction uses the declared chunk order. Live tests compare sender and receiver SHA-256 digests.

The encrypted envelope is larger than its plaintext chunk because the media body and ciphertext are Base64-url encoded. A shared 2 MiB ceiling bounds the controller request, renderer transport frame, Go request body, and Go offline queue entry while leaving room for a one-MiB plaintext chunk.

## Reliability policy

- The logical plaintext chunk remains 1 MiB. A 512 KiB comparison reached 0.094 MiB/s, while observed 1 MiB runs reached 0.139-0.237 MiB/s; the larger chunk reduces HTTP, encryption, and acknowledgement round trips.
- Independent Tor lanes use separate processes, data directories, and SOCKS ports. They are prewarmed independently and selected in round-robin order.
- Two lanes are the validated maximum for large transfers. Three lanes increased contention and reduced measured throughput.
- The release policy reserves two-lane transfer for photos and files of at least 200 MiB; smaller transfers retain the single-lane reliability path.
- Tor route readiness is verified before transfer begins.
- Transient forwarding failures re-prewarm the route and retry with bounded backoff in the live harness.
- The soak test intentionally removes and restores the sender's Tor proxy halfway through the file.
- Reverse chat is sent during the file transfer to verify that control/chat traffic remains usable.
- Duplicate event identifiers are counted and ignored during assembly.

## Validation commands

```bash
# Encrypted envelope sizing
npx vitest run src/main/__tests__/torMediaEnvelopeSize.test.ts

# Native transport, queue, and reusable SOCKS tunnel
npm run test:native

# Short local 500 MiB bounded-memory benchmark
npm run bench:transfer:500mb

# Real Tor staged transfers
npm run test:tor:large
npm run test:tor:large:10
npm run test:tor:large:100
npm run test:tor:large:100:lane2
npm run test:tor:large:100:lane3
npm run test:tor:large:500
```

Live commands require an installed Tor binary or `NKC_TOR_PATH`. Hidden-service publication time and throughput vary by circuit, so the 500 MiB test can take more than an hour.

## Validated measurements

Measurements below are from the Windows development host on 2026-07-19 and are not throughput guarantees.

| Scenario | Chunk size | Transfer time | Throughput | Additional checks |
| --- | ---: | ---: | ---: | --- |
| Real Tor 10 MiB, before sizing change | 128 KiB | 468.838 s | 0.021 MiB/s | Interruption recovery and matching SHA-256 |
| Real Tor 10 MiB, optimized | 1 MiB | 73.998 s | 0.135 MiB/s | Reverse chat 0.895 s, duplicates 0, matching SHA-256 |
| Real Tor 500 MiB, optimized | 1 MiB | 3,768.472 s | 0.133 MiB/s | P50/P95 6.780/10.834 s, reverse chat 4.168 s, duplicates 0, matching SHA-256 |
| Real Tor 100 MiB, one lane | 1 MiB | 484.834 s | 0.206 MiB/s | Interruption recovery, duplicates 0, matching SHA-256 |
| Real Tor 100 MiB, two independent lanes | 1 MiB | 422.397 s | 0.237 MiB/s | Best measured lane count, duplicates 0, matching SHA-256 |
| Real Tor 100 MiB, three independent lanes | 1 MiB | 941.120 s | 0.106 MiB/s | One duplicate rejected, matching SHA-256 |
| Real Tor 10 MiB, two lanes | 512 KiB | 106.804 s | 0.094 MiB/s | 20 chunks, duplicates 0, matching SHA-256 |

The one-MiB format improved the comparable 10 MiB live transfer by approximately 6.3 times by reducing Tor HTTP round trips from 80 to 10. Two independent lanes improved the measured 100 MiB run by about 15 percent over one lane; three lanes were slower and are not recommended.

## Change checklist

When changing chunk or payload sizing:

- update `src/net/mediaTransferLimits.ts`;
- keep `src/main/onionController.ts` and `src/net/transportManager.ts` aligned;
- keep `native/nkc-worker/transport.go` and `native/nkc-worker/queue.go` aligned;
- rerun the envelope-size test, Go tests, full Vitest suite, and production build;
- run at least one real Tor staged transfer when routing or payload behavior changes;
- confirm bounded memory, duplicate rejection, interruption recovery, reverse chat, and sender/receiver hash equality.
