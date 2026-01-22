# Migration Notes: Start Key and Device Sync

- Recovery key is removed. Use the start/login key for local unlock only.
- Account recovery is not supported if the original device is lost or unreachable.
- Multi-device sync requires an online existing device to approve a new device via a sync code.
- Key-only takeover on a new device is intentionally blocked.
- Legacy recovery key markers are cleaned up at runtime (nkc_recovery_confirmed_v1, recovery_key_v1, recovery_key_ids_v1).