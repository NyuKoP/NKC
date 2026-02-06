# Serverless Secure Chat (Electron + React + TS)

This repo contains a serverless, end-to-end encrypted P2P chat app built with Electron, React, and TypeScript.
It is designed to keep messages encrypted at rest and in transit, with onion-first transport and optional direct fallback.

## Security and Crypto
- Envelope encryption: XChaCha20-Poly1305 with AAD = canonicalized header JSON.
- Signatures: Ed25519 detached signatures; verify-first before decrypt.
- Keying: ECDH base key + optional PSK; friend codes for key exchange and TOFU.
- Ratchet: v2 DH ratchet (X25519) + symmetric chains, backward compatible with v1/legacy.
- Storage: encrypted event envelopes only; no plaintext message bodies in the database.

## Sync and Transport
- Event-log based sync (append-only `events` table).
- Deterministic apply ordering; dedup by eventId; replay protection.
- Transport manager: onion-first policy with optional direct fallback and UI warnings.
- Manual-only contacts sync; messages auto-sync when connected.

## Sync Conflict Rules
- Events are append-only; merges follow deterministic order (ts asc, authorDeviceId, lamport).
- Duplicates are ignored by eventId; replays (lamport <= seen) are dropped.
- Signatures are verified before storing or applying any event.
- Contacts sync runs only on explicit user action; messages can auto-sync when connected.
- Transport metadata is privacy-preserving (no IP/ICE strings stored).

## Devices and Roles
- Primary/Secondary device roles with guards for restricted actions.
- ROLE_CHANGE events are encrypted + signed in the global scope.
- Local device registry updates from events and warns on primary conflicts.

## Debugging and Verification
- Non-sensitive logs indicate decrypt path and commit timing (`[msg]`/`[sync]` with mode: legacy/v1/v2).
- Manual two-device checklist: `docs/manual-two-device-checklist.md`.

## Development
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Installer Packaging
This project supports installer packaging with `electron-builder`.

### Prerequisites
- Windows installer (`.exe`): run on Windows
- macOS installer (`.dmg`/`.zip`): run on macOS
- Linux installer (`.AppImage`/`.deb`): run on Linux

### Commands
```bash
# All targets for current host OS
npm run dist

# Windows NSIS installer
npm run dist:win

# macOS DMG + ZIP
npm run dist:mac

# Linux AppImage + DEB
npm run dist:linux
```

Generated artifacts are placed in `release/`.

### Notes
- Code signing/notarization is not configured yet. Unsigned installers may show OS warnings.
- Optional app icons can be added later under `build/` (for example `build/icon.ico`, `build/icon.icns`, `build/icon.png`).

## Release Info
### Latest Release
- Version: `v0.1.0`
- Release date (UTC): `2026-02-06T11:33:04.7357335Z`
- Channel: `stable`
- Installer/update outputs: `release/`
- Auto-update manifest: `release/latest.yml`

### Release Notes (`v0.1.0`)
- Applied network-mode changes only after explicit `Save`.
- Added background sync control wiring (`appControls.syncNow` and status events).
- Updated CI/package workflow matrix for Windows + macOS + Linux.
- Added Playwright E2E coverage for friend add flow and friend-list visibility.

## UI E2E Tests (Playwright)
- Install browsers: `npx playwright install chromium`
- Run headless: `npm run test:ui`
- Run headed: `npm run test:ui:headed`
- Update snapshots: `npm run test:ui -- --update-snapshots`

Artifacts (screenshots, videos, traces) are saved in `test-results/` and `playwright-report/` on failures.

## Repo Notes
- `dist-electron/` build outputs are ignored and not tracked in git.
