import type { TransportPacket } from "../adapters/transports/types";
import { decodeBase64Url } from "../security/base64url";
import { onIncomingPacket } from "../net/router";
import { handleIncomingFriendFrame, ingestIncomingEnvelopeText } from "../sync/syncEngine";
import { handleIncomingRelayPacket } from "../net/internalOnion/relayNetwork";
import { emitFriendRouteIncomingInfoLog } from "../diagnostics/infoCollectionLogs";

const textDecoder = new TextDecoder();
let started = false;
let onChangeCallback: (() => void) | null = null;

type FriendFrameType = "friend_req" | "friend_accept" | "friend_decline";

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

const toInfoLogErrorDetail = (error: unknown) => {
  if (error instanceof Error) {
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code?: string }).code ?? undefined)
        : undefined;
    return {
      name: error.name,
      message: error.message,
      code,
      stackTop: error.stack?.split("\n").slice(0, 3).join("\n"),
    };
  }
  return {
    message: String(error),
  };
};

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
      const commonContext = {
        relayed: relay.handled,
        hadDeliveredPacket: Boolean(relay.deliveredPacket),
      };
      emitFriendRouteIncomingInfoLog({
        direction: "incoming",
        status: "received",
        frameType: frame.type,
        source: "friends:startFriendInboxListener",
        via: meta.via,
        packetId: effectivePacket.id,
        convId: frame.convId,
        fromDeviceId: frame.from?.deviceId,
        toDeviceId: resolveToDeviceId(effectivePacket),
        context: commonContext,
      });
      try {
        await handleIncomingFriendFrame(
          parsed as Parameters<typeof handleIncomingFriendFrame>[0]
        );
      } catch (error) {
        emitFriendRouteIncomingInfoLog({
          direction: "incoming",
          status: "failed",
          frameType: frame.type,
          source: "friends:startFriendInboxListener",
          via: meta.via,
          packetId: effectivePacket.id,
          convId: frame.convId,
          fromDeviceId: frame.from?.deviceId,
          toDeviceId: resolveToDeviceId(effectivePacket),
          error: error instanceof Error ? error.message : String(error),
          errorDetail: toInfoLogErrorDetail(error),
          context: commonContext,
        });
        throw error;
      }
      emitFriendRouteIncomingInfoLog({
        direction: "incoming",
        status: "handled",
        frameType: frame.type,
        source: "friends:startFriendInboxListener",
        via: meta.via,
        packetId: effectivePacket.id,
        convId: frame.convId,
        fromDeviceId: frame.from?.deviceId,
        toDeviceId: resolveToDeviceId(effectivePacket),
        context: {
          ...commonContext,
          peerReceiptConfirmed:
            frame.type === "friend_accept" || frame.type === "friend_decline",
        },
      });
      onChangeCallback?.();
    })().catch((error) => console.warn("[friend] inbox handle failed", error));
  });
};
