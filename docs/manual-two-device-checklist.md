# Manual Two-Device Verification Checklist

This checklist validates v2-2 DH ratchet, ROLE_CHANGE conflict warning, and encrypted chunked media.
Use two devices (A/B) with the same account and at least one direct conversation.

## Setup
1) Pair devices A and B and open the same conversation.
2) Open DevTools Console on both devices (enable verbose logs to see `console.debug`).

Expected:
- Both devices can send/receive normal messages.
- No logs show keys/ciphertext.

## 1) v2-2 DH Ratchet

### 1.1 Ordered send (single sender)
Steps:
1) On A, send 3 short messages in sequence.
2) On B, wait for sync to complete.

Expected:
- Messages arrive in order.
- Console shows `[msg] path { mode: "v2" }` and `[msg] commit { mode: "v2" }` for each.
- `[sync] path { mode: "v2" }` appears for synced events (if syncing).

### 1.2 Alternating send
Steps:
1) A sends “A1”.
2) B sends “B1”.
3) A sends “A2”.
4) B sends “B2”.

Expected:
- All messages decrypt on the other device.
- Logs show v2 path for each new message.
- No “deferred” logs for these messages.

### 1.3 Gap > 50 (out-of-window)
Steps:
1) Put B offline.
2) On A, send 60 small messages.
3) Bring B back online and sync.

Expected:
- First ~50 messages decrypt (bounded skip).
- Remaining messages show placeholder “복호??보류”.
- Logs show `deferred` for v2.

### 1.4 Replay/duplicate
Steps:
1) Trigger a resync (disconnect/reconnect).
2) Observe messages that already exist.

Expected:
- Duplicates are ignored.
- Logs show replay drop messages in sync path (no duplicate UI entries).

### 1.5 Legacy/v1 fallback (backward compatibility)
Steps:
1) Open a conversation that has older events without `rk`.
2) Trigger a sync/load of those events.

Expected:
- Messages still decrypt.
- Logs show `mode: "legacy"` or `mode: "v1"` for those events.

## 2) ROLE_CHANGE Conflict Warning

### 2.1 Emit ROLE_CHANGE
Steps:
1) On A, in Settings → Devices, change role (Primary/Secondary).
2) Let B sync global events.

Expected:
- B updates its device registry (no crash).
- Console shows normal decrypt logs for global events.

### 2.2 Conflict detection
Steps:
1) On A, set role to Primary.
2) On B, also set role to Primary.
3) Ensure both devices connect and sync.

Expected:
- Settings → Devices shows a red banner:
  “Primary 충돌 감지: 여러 디바이스가 동시에 Primary로 설정되어 있습니다.”
- Banner lists deviceId (short), epoch, and lastSeenAt.
- No automatic role changes occur.

## 3) Encrypted Chunked Media

### 3.1 Send and receive
Steps:
1) On A, attach a medium-sized file (>=1 MB) and send.
2) On B, observe progress and completion.

Expected:
- Message body is a media reference (not raw bytes).
- Progress updates while chunks arrive.
- Once complete, file opens/saves correctly.

### 3.2 Resume after disconnect
Steps:
1) On B, disconnect transport mid-transfer.
2) Reconnect and allow resume.

Expected:
- Receiver requests from first missing chunk index.
- Transfer resumes without duplicate/invalid chunks.

### 3.3 Restart persistence
Steps:
1) While transfer is incomplete, restart B.
2) Reopen the conversation.

Expected:
- Resume starts from the first missing chunk.
- Completed media remains accessible across restarts.

### 3.4 Corruption handling
Steps:
1) Manually corrupt a stored chunk in IndexedDB (mediaChunks).
2) Try to open the media.

Expected:
- Verification fails and UI shows a corruption error.
- App does not crash; chunks remain stored for retry.

### 3.5 No plaintext at rest
Steps:
1) Inspect IndexedDB tables for media (e.g., `mediaChunks`/new media tables).

Expected:
- Stored data is ciphertext (base64); no plaintext file bytes.
