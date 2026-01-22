# WebRTC Manual Direct P2P Pairing

This is manual Direct P2P pairing using WebRTC signaling codes. There is no server, no QR code, and no Tor requirement for this step.

## Device A
1) Open Settings > Network.
2) Click Generate Offer.
3) Copy My Code.

## Device B
1) Paste the code into Paste Peer Code.
2) Click Apply Code.
3) Copy the generated Answer / ICE code from My Code.

## Back to Device A
1) Paste the Answer / ICE code.
2) Click Apply Code.

Notes:
- Multiple ICE codes may be exchanged.
- The connection is complete when the status shows "Connected".
