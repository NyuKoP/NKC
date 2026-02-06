import type { TransportPacket } from "../adapters/transports/types";
import { decodeBase64Url } from "../security/base64url";
import { onIncomingPacket } from "../net/router";
import { handleIncomingFriendFrame, ingestIncomingEnvelopeText } from "../sync/syncEngine";
import { handleIncomingRelayPacket } from "../net/internalOnion/relayNetwork";

const textDecoder = new TextDecoder();
let started = false;
let onChangeCallback: (() => void) | null = null;

const decodePayload = (payload: TransportPacket["payload"]) => {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return textDecoder.decode(payload);
  if (payload && typeof payload === "object" && "b64" in payload) {
    const b64 = (payload as { b64?: unknown }).b64;
    if (typeof b64 !== "string") return null;
    try {
      return textDecoder.decode(decodeBase64Url(b64));
    } catch {
      return null;
    }
  }
  return null;
};

export const startFriendInboxListener = (onChange?: () => void) => {
  if (onChange) {
    onChangeCallback = onChange;
  }
  if (started) return;
  started = true;
  onIncomingPacket((packet) => {
    void (async () => {
      const relay = await handleIncomingRelayPacket(packet);
      if (relay.handled && !relay.deliveredPacket) return;
      const effectivePacket = relay.deliveredPacket ?? packet;
      const text = decodePayload(effectivePacket.payload);
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const kind = (parsed as { type?: unknown }).type;
      if (
        kind !== "friend_req" &&
        kind !== "friend_accept" &&
        kind !== "friend_decline"
      ) {
        const handledEnvelope = await ingestIncomingEnvelopeText(text);
        if (handledEnvelope) {
          onChangeCallback?.();
        }
        return;
      }
      await handleIncomingFriendFrame(
        parsed as Parameters<typeof handleIncomingFriendFrame>[0]
      );
      onChangeCallback?.();
    })().catch((error) => console.warn("[friend] inbox handle failed", error));
  });
};
