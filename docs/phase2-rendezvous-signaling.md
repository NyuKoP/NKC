# Phase 2 Rendezvous Signaling

Phase 2 adds automatic WebRTC signaling using a rendezvous endpoint and a short
Sync Code. The manual NKC-RTC1 copy/paste panel remains as a fallback.

## Phase 2 (Rendezvous)
- Both devices can reach the same rendezvous base URL.
- The app generates a short Sync Code (e.g. `NKC-SYNC1-ABC123`).
- Signaling payloads are still the same `NKC-RTC1...` strings.

### Host (Device A)
1) Open Settings > Network.
2) Set Rendezvous URL.
3) Click "Create Sync Code (Host)".
4) Click "Start Host" and share the Sync Code.

### Join (Device B)
1) Open Settings > Network.
2) Set the same Rendezvous URL.
3) Paste the Sync Code and click "Join".

### Notes
- Multiple ICE payloads may be exchanged automatically.
- Connection completes when the pairing status shows "connected".
- If the Rendezvous URL is empty, use the manual pairing panel.

## Phase 2.1 (Onion-proxied signaling)
- When "Use Onion for signaling" is enabled, rendezvous HTTP requests are sent
  through the main-process onion proxy fetch (IPC).
- If onion proxy fetch is unavailable, the UI warns and uses direct fetch.

Security note: the rendezvous server only sees signaling blobs, not chat data.
