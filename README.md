# NKC

NKC is a serverless, end-to-end encrypted desktop chat application built with Electron, React, TypeScript, and a native Go worker. It stores encrypted event envelopes locally and routes peer-to-peer traffic through privacy-preserving transports, through Tor onion services.

> **Beta source snapshot:** `0.5.0-beta` is under active development. Security qualification, including rollback protection, is incomplete. Do not rely on this build for sensitive communications or use it as a production release.

## Features

- End-to-end encrypted direct and group conversations
- Ed25519 signatures and X25519-based key agreement
- XChaCha20-Poly1305 envelope encryption with authenticated headers
- Versioned ratchet support and replay protection
- Encrypted local storage backed by IndexedDB
- Friend codes, device pairing, authorization, unlinking, and device synchronization
- Recovery-key settings and account-bound storage and session handling
- Message ordering, group membership handling, and history synchronization
- Media transfer status, storage, recovery, and receipt handling
- Updated onboarding, profile, avatar, chat, and settings screens
- Tor onion-service routing
- Electron main/preload isolation with a narrow, validated IPC bridge
- Sandboxed `nkc-app://` renderer loading, restricted permissions, and Electron Fuses
- Approved-origin controls for custom rendezvous servers
- Native worker integrity verification in packaged applications
- Native Go worker for SOCKS5/HTTP transport, connection pooling, offline queue, scheduling, and file operations
- Bounded-memory file transfer with 1 MiB plaintext chunks

Feature descriptions identify source behavior and are not independent-device or real-Tor acceptance results. A local handoff is not proof of remote receipt or storage. Direct LAN, Wi-Fi Direct, and Bluetooth messaging are outside the project scope.

For the security rules that implementations must preserve, see [Transport Security Invariants](docs/SECURITY-transport-invariants.md).

## Requirements

- Node.js and npm compatible with the versions used by the lockfile
- Go `1.26.9` or newer for the native worker
- A supported Electron desktop platform: Windows, macOS, or Linux
- Tor for messenger transport

## Getting Started

Install dependencies:

```bash
npm install
```

Start the Vite development server:

```bash
npm run dev
```

To build first and then launch Electron:

```bash
npm start
```

Set `NKC_SKIP_BUILD=1` when using `npm start` with an existing build.

## Validation

Run the local source checks:

```bash
npm run build
npm run lint
npm run lint:encoding
npm audit --omit=dev --audit-level=high
```

The unit, native, and UI test suites are maintained outside this public source snapshot. These commands alone do not qualify a release. CI deliberately reports that security qualification is required.

## Live Tor Tests

Live acceptance requires an installed Tor binary and separate endpoints. The private test suite covers staged file-transfer sizes, encryption, integrity, duplicate detection, reverse chat during transfers, and recovery after interruptions. Those scenarios are not included in this public snapshot and must not be assumed to pass for this beta.

A historical 500 MiB run on one Windows test host took 3,768.472 seconds at 0.133 MiB/s. This is historical evidence for that run, not a current beta performance promise or independent-device acceptance. Tor performance varies by circuit and service publication time.

## Packaging

Local installer packaging uses `electron-builder`:

```bash
npm run dist        # Targets for the current host OS
npm run dist:win    # Windows NSIS; currently blocked by the security gate
npm run dist:mac    # macOS DMG and ZIP
npm run dist:linux  # Linux AppImage and DEB
```

Artifacts are written to `release/`. Local packaging is for development and does not establish release readiness. The Windows command intentionally fails until the private rollback security gate is satisfied. The tag-triggered workflow also blocks unqualified installer publication. The beta release contains source archives only; no installer has been qualified or attached.

Electron Fuses are configured during packaging to restrict Node execution, inspection, and extra `file://` privileges and enforce ASAR integrity. See [Release Security](RELEASE-SECURITY.md) for the existing release-security guidance; signing and distribution must be reconciled with the current build and independently verified before any installer is published.

## Configuration

Common development and runtime environment variables include:

| Variable | Purpose |
| --- | --- |
| `NKC_TOR_PATH` | Path to a Tor executable used by the managed Tor runtime |
| `NKC_TOR_BRIDGES` | Tor bridge/circumvention mode override |
| `NKC_TOR_COUNTRY` | Tor country setting used by the runtime |
| `NKC_GO_WORKER_PATH` | Path to a prebuilt native worker |
| `NKC_SYSTEM_TOR_BIN` | System Tor binary considered by the onion runtime |
| `VITE_RENDEZVOUS_BASE_URL` | Rendezvous signaling endpoint override |
| `VITE_RENDEZVOUS_USE_ONION` | Enables onion-proxied rendezvous signaling |
| `VITE_INFO_COLLECTION_LOGS` | Enables diagnostic information-collection logs |
| `OPEN_DEV_TOOLS` | Opens Electron developer tools at startup |

Do not commit secrets, private keys, start keys, friend codes, bridge credentials, or local runtime data.

Custom rendezvous origins require explicit approval in the packaged application. Non-Onion
origins must use HTTPS and cannot resolve to loopback, link-local, or private-network addresses.

Login settings store the close behavior as a mutually exclusive choice: selecting **Exit**
disables hide-to-tray and background operation, while selecting **Hide to tray** disables Exit.
Preference writes are serialized so rapid setting changes are persisted in order.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/app/`, `src/components/` | React application shell and UI |
| `src/main.ts` | Electron main process and IPC registration |
| `src/preload.ts` | Renderer-facing Electron bridge |
| `src/crypto/`, `src/security/` | Cryptography, identity, ratchet, and trust logic |
| `src/net/`, `src/adapters/transports/` | Routing and transport implementations |
| `src/sync/`, `src/storage/`, `src/db/` | Synchronization and persistent data |
| `src/main/onion/`, `src/main/tor/` | Managed onion components and Tor runtime |
| `native/nkc-worker/` | Native Go worker for transport, queueing, scheduling, and file operations |
| `docs/` | Architecture, operations, migration, and manual test documentation |
| `scripts/` | Build and pin-generation utilities |

## Documentation

Start with the [documentation index](docs/README.md). Important references include:

- [Transport and Routing Architecture](docs/ARCH-transport-and-routing.md)
- [Large File Transfer](docs/LARGE-FILE-TRANSFER.md)
- [File Transfer Crypto Optimization](docs/CRYPTO-TRANSFER-OPTIMIZATION.md)
- [Transport Security Invariants](docs/SECURITY-transport-invariants.md)
- [Release Security](RELEASE-SECURITY.md)
- [Security Policy](SECURITY.md)
- [Two-Device Manual Checklist](docs/manual-two-device-checklist.md)
- [Phase 4.6 Operations](docs/phase46-operations.md)
- [Contributing Guide](CONTRIBUTING.md)

## Security Notice

NKC handles cryptographic keys and private communications. Treat changes to cryptography, storage, transport selection, IPC, device trust, and logging as security-sensitive. Never weaken signature-before-decryption, encrypted-at-rest storage, replay protection, or routing-metadata privacy without an explicit design review.

## License

NKC is licensed under GPL version 3 only.
See [LICENSE](LICENSE).
