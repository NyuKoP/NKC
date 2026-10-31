# NKC

NKC is a serverless, end-to-end encrypted desktop chat application built with Electron, React, TypeScript, and a native Go worker. It stores encrypted event envelopes locally and routes peer-to-peer traffic through privacy-preserving transports, with Tor onion services.

> **Project status:** active development. The current package version is `0.5.0-beta`; interfaces, storage formats, and network behavior may still change.

## Features

- End-to-end encrypted direct and group conversations
- Ed25519 signatures and X25519-based key agreement
- XChaCha20-Poly1305 envelope encryption with authenticated headers
- Versioned ratchet support and replay protection
- Encrypted local storage backed by IndexedDB
- Friend codes, device pairing, and primary/secondary device roles
- Tor onion-service routing
- Electron main/preload isolation with a narrow, validated IPC bridge
- Sandboxed `nkc-app://` renderer loading, restricted permissions, and Electron Fuses
- Approved-origin controls for custom rendezvous servers
- Native worker integrity verification in packaged applications
- Native Go worker for SOCKS5/HTTP transport, connection pooling, offline queue, scheduling, and file operations
- Bounded-memory file transfer up to 500 MiB with 1 MiB encrypted chunks

For the security rules that implementations must preserve, see [Transport Security Invariants](docs/SECURITY-transport-invariants.md).

## Requirements

- Node.js and npm compatible with the versions used by the lockfile
- Go `1.26` or newer for the native worker
- A supported Electron desktop platform: Windows, macOS, or Linux
- Tor for messenger transport

## Getting Started

Install dependencies:

```bash
npm install
```

Start the Vite development server and Electron application:

```bash
npm run dev
```

To build first and then launch Electron:

```bash
npm start
```

Set `NKC_SKIP_BUILD=1` when using `npm start` with an existing build.

## Validation

Run `npm run build`, `npm run lint`, and `npm run lint:encoding` for local source checks. The test suite is maintained outside this public source snapshot. These checks do not qualify a release.

**Release blocked:** security qualification and rollback protection remain unresolved. Do not use this source snapshot as a production release.

## Packaging

Release publication is blocked until security qualification is complete. Local packaging is for development only and does not establish release readiness.

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
