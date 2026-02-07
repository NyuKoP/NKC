import type { TransportPacket } from "../adapters/transports/types";
import { decodeBase64Url } from "../security/base64url";
import { onIncomingPacket, type IncomingPacketMeta } from "../net/router";
import { handleIncomingFriendFrame, ingestIncomingEnvelopeText } from "../sync/syncEngine";
import { handleIncomingRelayPacket } from "../net/internalOnion/relayNetwork";

const textDecoder = new TextDecoder();
let started = false;
let onChangeCallback: (() => void) | null = null;

type FriendFrameType = "friend_req" | "friend_accept" | "friend_decline";

type FriendRouteTestLog = {
  direction: "incoming";
  frameType: FriendFrameType;
  via: IncomingPacketMeta["via"];
  packetId: string;
  convId?: string;
  fromDeviceId?: string;
  toDeviceId?: string;
  timestamp: string;
};

const emitFriendRouteTestLog = (payload: FriendRouteTestLog) => {
  console.info("[test][friend-route]", payload);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nkc:test:friend-route", { detail: payload }));
  }
};

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

const resolveToDeviceId = (packet: TransportPacket) =>
  (packet as { toDeviceId?: string }).toDeviceId ??
  (packet as { route?: { toDeviceId?: string; to?: string } }).route?.toDeviceId ??
  (packet as { to?: string }).to ??
  (packet as { route?: { toDeviceId?: string; to?: string } }).route?.to;

export const startFriendInboxListener = (onChange?: () => void) => {
  if (onChange) {
    onChangeCallback = onChange;
  }
  if (started) return;
  started = true;
  onIncomingPacket((packet, meta) => {
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
      const frame = parsed as {
        type: FriendFrameType;
        convId?: string;
        from?: { deviceId?: string };
      };
      emitFriendRouteTestLog({
        direction: "incoming",
        frameType: frame.type,
        via: meta.via,
        packetId: effectivePacket.id,
        convId: frame.convId,
        fromDeviceId: frame.from?.deviceId,
        toDeviceId: resolveToDeviceId(effectivePacket),
        timestamp: new Date().toISOString(),
      });
      await handleIncomingFriendFrame(
        parsed as Parameters<typeof handleIncomingFriendFrame>[0]
      );
      onChangeCallback?.();
    })().catch((error) => console.warn("[friend] inbox handle failed", error));
  });
};
