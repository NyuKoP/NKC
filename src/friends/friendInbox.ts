import type { TransportPacket } from "../adapters/transports/types";
import { decodeBase64Url } from "../security/base64url";
import { onIncomingPacket } from "../net/router";
import { handleIncomingFriendFrame } from "../sync/syncEngine";

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
    const text = decodePayload(packet.payload);
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
    const kind = (parsed as { type?: unknown }).type;
    if (kind !== "friend_req" && kind !== "friend_accept" && kind !== "friend_decline") {
      return;
    }
    void handleIncomingFriendFrame(
      parsed as Parameters<typeof handleIncomingFriendFrame>[0]
    )
      .then(() => onChangeCallback?.())
      .catch((error) => console.warn("[friend] inbox handle failed", error));
  });
};
