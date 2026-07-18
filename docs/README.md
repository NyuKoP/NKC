# NKC Documentation

This directory contains current architectural references, operational guidance, migration notes, manual test procedures, and historical implementation-phase documents.

## Start Here

- [Project overview and setup](../README.md)
- [Contributing and validation](../CONTRIBUTING.md)
- [Transport and routing architecture](ARCH-transport-and-routing.md)
- [Transport security invariants](SECURITY-transport-invariants.md)
- [Manual two-device checklist](manual-two-device-checklist.md)

## Architecture and Security

| Document | Scope |
| --- | --- |
| [Transport and Routing Architecture](ARCH-transport-and-routing.md) | Available transports, route policy, controller contracts, and error classes |
| [Transport Security Invariants](SECURITY-transport-invariants.md) | Security properties that transport changes must preserve |
| [WebRTC Manual Pairing](webrtc-manual-pairing.md) | Manual direct peer-to-peer offer/answer pairing flow |

## Operations and Testing

| Document | Scope |
| --- | --- |
| [Manual Two-Device Checklist](manual-two-device-checklist.md) | Start-key, approval, offline-device, and one-time-code checks |
| [Phase 4.6 Operations](phase46-operations.md) | Polling, backoff, transport-state stability, and operational errors |

## Migration and Release Notes

| Document | Scope |
| --- | --- |
| [Start Key and Device Sync Migration](migration-start-key.md) | Behavioral changes for account start keys and synchronized devices |
| [NKC v0.1.1](releases/v0.1.1.md) | Historical release notes for version 0.1.1 |

## Implementation History

The phase documents describe how network capabilities were introduced. They are useful design history, but the source code and current architecture/security documents take precedence if behavior has changed.

1. [Phase 2: Rendezvous Signaling](phase2-rendezvous-signaling.md)
2. [Phase 3: Onion Transport](phase3-onion-transport.md)
3. [Phase 3.5: Local Onion Controller](phase35-onion-controller.md)
4. [Phase 4: Tor Hidden Service Transport](phase4-tor-hidden-service.md)
5. [Phase 4.5: Lokinet and Route Policy](phase45-lokinet-and-routing.md)
6. [Phase 4.6: Operations](phase46-operations.md)

## Documentation Rules

- Write documentation in English.
- Prefer repository-relative links and commands that exist in `package.json`.
- Mark historical or experimental behavior clearly.
- Do not include private keys, start keys, friend codes, credentials, real onion addresses, or user data.
- Update the root README and this index when adding a new long-lived document.
