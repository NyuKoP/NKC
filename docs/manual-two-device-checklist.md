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
