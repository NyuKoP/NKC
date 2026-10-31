import { receiveSucceeded, type IncomingCompletion } from "../sync/receiveCompletion";
import type { TransportPacket } from "../adapters/transports/types";
import { firstMessageMeasurement } from "../diagnostics/coldStartMetrics";
import { decodeBase64Url } from "../security/base64url";
import { onIncomingPacket, type IncomingPacketMeta } from "../net/router";
import { handleIncomingFriendFrame, ingestIncomingEnvelopeText, ingestIncomingProtocolText } from "../sync/syncEngine";
import { countSessionStage } from "../diagnostics/sessionInvestigation";
import { handleIncomingRelayPacket } from "../net/internalOnion/relayNetwork";
import { emitFlowTraceLog, emitFriendRouteIncomingInfoLog } from "../diagnostics/infoCollectionLogs";

const textDecoder = new TextDecoder();

const protocolFailureCodes = new Set([
  "OWNER_REQUIRED", "DEVICE_AUTHORIZATION_REQUIRED", "CONTROL_AUTHENTICATION_REJECTED", "CONTROL_SCOPE_REJECTED",
  "CONTROL_REPLY_REJECTED", "HISTORY_INVENTORY_LIMIT", "HISTORY_INVENTORY_REQUIRED", "FLOW_SEQUENCE_CONFLICT",
  "FRESH_SESSION_REQUIRED", "FRIEND_AUTHENTICATION_REQUIRED", "HELLO_REJECTED", "ACK_REJECTED",
  "SYNC_REQ_REJECTED", "FLOW_ACK_REJECTED", "CONTROL_PEER_BINDING_UNAVAILABLE",
]);

let started = false;

let onChangeCallback: ((event?: { type: FriendFrameType }) => void) | null = null;

let getLocalFriendCodeCallback: (() => Promise<string | undefined>) | null = null;

type FriendFrameType = "friend_req" | "friend_accept" | "friend_decline" | "profile_update";

const decodePayload = (payload: TransportPacket["payload"]) => {
  if (typeof payload === "string") return payload;

  if (payload instanceof Uint8Array) return textDecoder.decode(payload);

  if (payload && typeof payload === "object" && "b64" in payload) {
    const b64 = payload.b64;

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
  (packet).toDeviceId ??
  (packet).route?.toDeviceId ??
  (packet).to ??
  (packet).route?.to;

const toInfoLogErrorDetail = (error: unknown) => {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? (error.code ?? undefined)
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

export const startFriendInboxListener = (
  onChange?: (event?: { type: FriendFrameType }) => void,
  options?: { getLocalFriendCode?: () => Promise<string | undefined> }
) => {
  if (onChange) {
    onChangeCallback = onChange;
  }

  if (options?.getLocalFriendCode) {
    getLocalFriendCodeCallback = options.getLocalFriendCode;
  }

  if (started) return;
  started = true;
  onIncomingPacket(dispatchFriendInboxPacket, { authority: 100 });
};

/** The authoritative application dispatcher shared by ordinary polling and disposable acceptance. */
export const dispatchFriendInboxPacket = async (packet: TransportPacket, meta: IncomingPacketMeta): Promise<IncomingCompletion | void> => {
    try {
      const context = meta.receiveContext;

      if (!context) return { status: "FAILED", code: "OWNER_REQUIRED" };
      countSessionStage("authority", "input");
      await context.vault.assertMain();
      countSessionStage("authority", "success");

        if (meta.binaryPacketBytes) {
          const completion = await ingestIncomingEnvelopeText(meta.binaryPacketBytes, {
            replyRoute: packet.replyRoute, diagnosticContext: { parentId: packet.id, deliveryPath: "direct" },
          }, context);

          if (receiveSucceeded(completion)) onChangeCallback?.();

          return completion;
        }

      const relay = await handleIncomingRelayPacket(packet, context);
      await context.vault.assertMain();

      if (relay.handled && !relay.deliveredPacket) return relay.completion === "OWNER_BOUND_EPHEMERAL"
        ? { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId }
        : { status: "FAILED", code: "RELAY_COMPLETION_UNVERIFIED" };
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

      if (typeof kind === "string" && ["HELLO", "ACK", "SESSION_READY", "SYNC_REQ", "SYNC_RES", "SYNC_FLOW_ACK"].includes(kind)) {
        countSessionStage("control", "input");
        const completion = await ingestIncomingProtocolText(text, effectivePacket.replyRoute, context);

        try {
          emitFlowTraceLog({ event: "protocol:receive:completion", frameType: kind,
            completionStatus: completion?.status ?? "NOT_HANDLED",
            normalizedCode: completion?.status === "FAILED"
              ? protocolFailureCodes.has(completion.code) ? completion.code : "PROTOCOL_RECEIVE_FAILED" : "none" });
        } catch { /* Passive observation cannot change receipt or retry decisions. */ }

        if (receiveSucceeded(completion)) onChangeCallback?.();

        return completion;
      }

      if (
        kind !== "friend_req" &&
        kind !== "friend_accept" &&
        kind !== "friend_decline" &&
        kind !== "profile_update"
      ) {
        const handledEnvelope = await ingestIncomingEnvelopeText(text, {
          replyRoute: effectivePacket.replyRoute,
          diagnosticContext: { parentId: packet.id, deliveryPath: relay.deliveredPacket ? "relay" : "direct" },
        }, context);

        if (receiveSucceeded(handledEnvelope)) {
          onChangeCallback?.();
        }

        return handledEnvelope;
      }

      const frame = parsed as {
        type: FriendFrameType;
        convId?: string;
        traceId?: string;
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
        traceId: frame.traceId,
        via: meta.via,
        packetId: effectivePacket.id,
        convId: frame.convId,
        fromDeviceId: frame.from?.deviceId,
        toDeviceId: resolveToDeviceId(effectivePacket),
        context: commonContext,
      });

      try {
        const handled = await handleIncomingFriendFrame(
          parsed as Parameters<typeof handleIncomingFriendFrame>[0],
          {
            localFriendCode: await getLocalFriendCodeCallback?.(),
            diagnosticPacketId: effectivePacket.id,
            replyRoute: effectivePacket.replyRoute,
          }, context
        );

        if (!handled) {
          emitFriendRouteIncomingInfoLog({
            direction: "incoming",
            status: "dropped",
            frameType: frame.type,
            source: "friends:startFriendInboxListener",
            traceId: frame.traceId,
            via: meta.via,
            packetId: effectivePacket.id,
            convId: frame.convId,
            fromDeviceId: frame.from?.deviceId,
            toDeviceId: resolveToDeviceId(effectivePacket),
            context: commonContext,
          });

          return;
        }
      } catch (error) {
        firstMessageMeasurement.stage(effectivePacket.id, "failed");
        emitFriendRouteIncomingInfoLog({
          direction: "incoming",
          status: "failed",
          frameType: frame.type,
          source: "friends:startFriendInboxListener",
          traceId: frame.traceId,
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
        traceId: frame.traceId,
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
      await context.vault.assertMain();
      onChangeCallback?.({ type: frame.type });

      return { status: "CONTROL_APPLIED", accountId: context.owner.accountId, operationId: context.owner.operationId };
    } catch { return { status: "FAILED", code: "FRIEND_RECEIVE_FAILED" }; }

};
