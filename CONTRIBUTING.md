# Contributing to NKC

Thank you for improving NKC. This project combines desktop UI, local encrypted storage, peer-to-peer networking, managed privacy runtimes, and a native worker. Keep changes focused and validate the layer you modify.

## Development Setup

1. Install Node.js, npm, and Go `1.26` or newer.
2. Install JavaScript dependencies with `npm install`.
3. Start the development application with `npm run dev`.

The renderer entry point is `src/main.tsx`, the Electron main process is `src/main.ts`, and the preload bridge is `src/preload.ts`.

## Before Submitting a Change

Run the checks relevant to your work:

```bash
npm run lint
npm run lint:encoding
npm test -- --run
npm run test:native
npm run build
```

Run `npm run test:ui` for user-flow or visual changes. Run the live Tor commands only when Tor is installed and the change affects its actual runtime path.

Focused tests are encouraged during development:

```bash
npx vitest run path/to/file.test.ts
npx eslint path/to/changed-file.ts
```

## Change Guidelines

- Preserve unrelated working-tree changes.
- Follow the existing architecture instead of creating parallel state, IPC, or transport layers.
- Keep Electron capabilities behind the preload bridge; do not expose unrestricted Node.js access to the renderer.
- Add or update tests for behavior changes and regressions.
- Avoid unrelated refactors in a focused bug fix.
- Keep logs free of message plaintext, keys, friend codes, credentials, IP addresses, ICE details, and other identifying routing metadata.
- Update documentation when commands, configuration, architecture, security guarantees, or user-visible workflows change.

## Security-Sensitive Changes

Changes in `src/crypto/`, `src/security/`, transport selection, persistence, device trust, or Electron IPC require extra care. Preserve the rules in [Transport Security Invariants](docs/SECURITY-transport-invariants.md), including signature verification before decryption and storage, encrypted-at-rest records, replay protection, and privacy-safe routing metadata.

Do not replace established cryptographic primitives or alter serialization/AAD formats without compatibility analysis and dedicated tests.

## Native Worker

The native worker lives in `native/nkc-worker/` and is built into `native/bin/` by:

```bash
npm run build:native
```

Test it with:

```bash
npm run test:native
```

Set `GO_BINARY` only when the Go executable is not discoverable through the normal environment.

## Documentation

Documentation is written in English. Add durable technical documents under `docs/`, link them from [the documentation index](docs/README.md), and distinguish current behavior from historical phase notes.

## Commit Scope

Use small, descriptive commits. A commit should contain one coherent change and its tests or documentation. Do not commit generated build output, test reports, local logs, runtime data, or secrets.
