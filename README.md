# NKC

NKC is an experimental desktop messenger built with Electron, React, TypeScript, and a native Go worker. Its messaging design uses encrypted local storage and Tor onion services.

> **Beta source snapshot:** `0.5.0-beta` is under active development. Security qualification, including rollback protection, is incomplete. Do not rely on this build for sensitive communications or use it as a production release.

## What is in this beta

- Device pairing, authorization, unlinking, and synchronization.
- Recovery-key settings and account-bound storage and session handling.
- Direct and group messaging, message ordering, and history synchronization.
- Media transfer status, storage, recovery, and receipt handling.
- Tor connection management and an offline queue in the native worker.
- Updated onboarding, profile, avatar, chat, and settings screens.

These describe source changes, not a guarantee that every flow has passed independent-device or real-Tor acceptance. A sender's local handoff is not proof of remote receipt or storage. NKC does not support direct LAN, Wi-Fi Direct, or Bluetooth messaging.

## Getting started

Requirements:

- Node.js and npm compatible with the lockfile.
- Go 1.26.9 or newer to build the native worker.
- A supported Electron desktop environment and internet access for Tor.

```bash
npm ci
npm run build
npm start
```

`npm run dev` starts the Vite development server. Local builds are for development and do not establish release readiness.

## Validation and release status

```bash
npm run lint
npm run lint:encoding
npm run build
npm audit --omit=dev --audit-level=high
```

The test suite is maintained outside this public source snapshot. CI intentionally reports that security qualification is required, and the release workflow blocks unqualified installer publication. Rollback protection remains an open release blocker. The beta release contains source code only; no installer has been qualified or attached.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/app/`, `src/components/` | Application shell and interface |
| `src/main.ts`, `src/preload.ts` | Electron main process and renderer bridge |
| `src/crypto/`, `src/security/` | Cryptography, identity, and trust |
| `src/net/`, `src/adapters/transports/` | Routing and transport |
| `src/sync/`, `src/storage/`, `src/db/` | Synchronization and storage |
| `src/main/onion/`, `src/main/tor/` | Tor runtime and onion components |
| `native/nkc-worker/` | Native transport and queue worker |

See the [documentation index](docs/README.md), [transport security invariants](docs/SECURITY-transport-invariants.md), [release security](RELEASE-SECURITY.md), and [contributing guide](CONTRIBUTING.md).

## License

[GPL-3.0-only](LICENSE).
