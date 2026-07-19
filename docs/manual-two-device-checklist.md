# Manual Two-Device Checklist

This checklist validates the new device sync policy (start key, sync code, approval).

## 1) Start key does not restore old account
Steps:
1) Fresh install on device B (no local DB).
2) Enter the start key from device A in onboarding.

Expected:
- Device B creates a new account (new identity keys).
- No conversations or friends are imported.

## 2) Online approval flow
Steps:
1) On device A, go to Settings -> Devices/Sync -> "새 기기 추가(코드 생성)".
2) On device B, go to Settings -> Devices/Sync -> "기기 연결(코드 입력)" and enter the code.
3) On device A, approve the pending request.

Expected:
- Device B shows approval success and sync starts.
- Contacts and conversation list appear after sync.

## 3) Existing device offline
Steps:
1) Turn off or disconnect device A.
2) On device B, attempt to connect with a sync code.

Expected:
- Device B shows a message that the existing device must be online.
- No sync occurs; device B continues as a new account.

## 4) One-time and expired code
Steps:
1) Generate a sync code on device A.
2) Wait for expiration or use the code once, then try to reuse it.

Expected:
- Expired codes fail.
- Reused codes fail; a new code must be generated.

## 5) Friend-code request and acceptance over Tor

Steps:

1. Start Tor on devices A and B and wait until both publish onion addresses.
2. On device A, add device B using B's friend code.
3. Confirm that device B shows A as a pending incoming request.
4. Open A's pending entry on device B and select **Accept**.
5. Return to device A and open the friend list.

Expected:

- The initial request reaches B even when A starts in the default self-onion mode.
- B can accept without an already-established friendship route.
- A receives `friend_accept` and shows B's supplied display name and status.
- Both profiles retain the current friend code and Tor/Lokinet routing hints.
- Invalidly signed or protocol-invalid control frames are logged as dropped and do not change profiles or conversations.

## 6) Large file and concurrent chat

Steps:

1. Send a file large enough to span multiple 1 MiB chunks.
2. Send a chat message in the reverse direction during transfer.
3. Temporarily interrupt the sender's Tor proxy and restore it.
4. Wait for transfer completion and compare the source and received file hashes.

Expected:

- Chat remains usable during the file transfer.
- Transfer resumes after the Tor route is restored.
- No duplicate chunks are assembled.
- Source and destination SHA-256 values match.
