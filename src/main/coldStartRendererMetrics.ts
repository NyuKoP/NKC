import { coldStartTelemetry as cold } from "./coldStartTelemetry";
import { decodeBinaryTransportPacket } from "../adapters/transports/packetCodec";
import { getTorProbeErrorCode, probeNetworkStages } from "./torProbeError";
import { decodeInboxTransportPacket } from "../adapters/transports/packetCodec";
import type { RendererColdMetric } from "../diagnostics/coldStartMetrics";

const rendererEvents = ["p2p.user_send", "p2p.peer_received", "p2p.peer_stored", "p2p.authenticated_read", "p2p.transport_ack", "renderer.startup_step"] as const;

export class ColdStartRendererMetrics {
  private firstOutgoing: string | null = null;
  private forwarded = false;
  private firstQueueId: string | null = null;
  private count = 0;
  private firstFriend: string | null = null;
  private friendQueueId: string | null = null;
  private selectedIncoming = new Map<"chat" | "friend", string>();
  private incoming = new Map<string, Array<{ deliveryStage: NonNullable<RendererColdMetric["deliveryStage"]>; observedMs: number; rendererMs?: number; deliveryPath?: RendererColdMetric["deliveryPath"]; deliveryOccurrence?: "first" | "later"; conversationOpen?: boolean }>>();
  private readonly enabled: boolean;
  private readonly allowSelection: boolean;
  constructor(enabled = process.env.NKC_COLD_START_TRACE === "1", allowSelection = Boolean(process.env.NKC_E2E_USER_DATA_DIR)) { this.enabled = enabled; this.allowSelection = allowSelection; }
  record(payload: unknown) {
    if (!this.enabled || !payload || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    const messageId = typeof value.messageId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.messageId) ? value.messageId : null;

    if (value.event === "p2p.diagnostic_select" && this.allowSelection && messageId && (value.messageKind === "chat" || value.messageKind === "friend")) {
      if (this.selectedIncoming.has(value.messageKind)) return;
      this.selectedIncoming.set(value.messageKind, messageId);

      for (const observation of this.incoming.get(messageId) ?? []) cold.mark("p2p.delivery.stage", { ...observation, messageKind: value.messageKind });

      return;
    }

    if (value.event === "p2p.receive_stage" && messageId) {
      const stage = (["decoded", "message_decoded", "decode_failed", "verified", "decrypted", "stored", "refresh_requested", "state_updated", "rendered", "displayed", "duplicate_rejected", "replay_rejected", "failed"] as const).find(s => s === value.deliveryStage);

      if (stage) {
        const path = (["direct", "sync_response", "relay", "unknown"] as const).find(p => p === value.deliveryPath);
        const id = messageId;

        // Identities remain transient; associate only exact parent observations.
        if (path && typeof value.parentId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.parentId)) {
          for (const row of [...(this.incoming.get(value.parentId) ?? [])]) {
            if (!row.deliveryPath && ["controller_received", "controller_accepted", "decoded"].includes(row.deliveryStage)) this.capture(id, row.deliveryStage, row.rendererMs, path, undefined, row.observedMs);
          }
        }

        this.capture(id, stage, typeof value.rendererMs === "number" && Number.isFinite(value.rendererMs) && value.rendererMs >= 0 ? value.rendererMs : undefined,
          path, typeof value.conversationOpen === "boolean" ? value.conversationOpen : undefined);
      }

      return;
    }

    if (value.event === "p2p.friend_send" && messageId && !this.firstFriend) {
      this.firstFriend = messageId; cold.mark("p2p.friend_send", { messageKind: "friend", rendererMs: typeof value.rendererMs === "number" ? value.rendererMs : undefined });

 return;
    }

    if (this.count >= 64) return;
    const event = rendererEvents.find((name) => name === value.event);

    if (!event || typeof value.rendererMs !== "number" || !Number.isFinite(value.rendererMs) || value.rendererMs < 0) return;

    if (event === "p2p.user_send" && !this.firstOutgoing && typeof value.messageId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.messageId)) this.firstOutgoing = value.messageId;
    const initStage = (["verify_key", "repair_text", "list_profiles", "restore_conversations"] as const).find((name) => name === value.initStage);
    cold.mark(event, { rendererMs: value.rendererMs, durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined, initStage });
    this.count++;
  }
  queueDiagnosticId() { return this.enabled ? this.firstQueueId ?? this.friendQueueId : null; }
  queueDiagnosticKind() { return this.firstQueueId ? "chat" as const : this.friendQueueId ? "friend" as const : undefined; }
  inbound(envelope: string, deliveryStage: "controller_received" | "controller_accepted") {
    if (!this.enabled || envelope.length > 3 * 1024 * 1024) return;
    const id = decodeInboxTransportPacket(envelope)?.id;

    if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) this.capture(id, deliveryStage);
  }
  private capture(id: string, deliveryStage: NonNullable<RendererColdMetric["deliveryStage"]>, rendererMs?: number, deliveryPath?: RendererColdMetric["deliveryPath"], conversationOpen?: boolean, observedMs = cold.elapsedNow()) {
    const observations = this.incoming.get(id) ?? [];

    if (observations.some(row => row.deliveryStage === deliveryStage && row.deliveryPath === deliveryPath)) return;

    if (observations.length >= 64) return;

    if (!this.incoming.has(id) && this.incoming.size >= 128) this.incoming.delete(this.incoming.keys().next().value!);

    const observation = { deliveryStage, observedMs, rendererMs,
      ...(deliveryPath ? { deliveryPath, deliveryOccurrence: observations.some(row => row.deliveryStage === deliveryStage) ? "later" as const : "first" as const } : {}),
      ...(conversationOpen === undefined ? {} : { conversationOpen }) };

    observations.push(observation); this.incoming.set(id, observations);

    for (const [messageKind, selected] of this.selectedIncoming) if (selected === id) cold.mark("p2p.delivery.stage", { ...observation, messageKind });
  }
  nativeResult(payload: unknown, result: { status: number; body: Record<string, unknown>; traces?: Array<Record<string, unknown>> }) {
    if (!this.enabled) return;

    try {
      const envelope = (payload as { envelope?: unknown })?.envelope;

      if (typeof envelope !== "string" || envelope.length > 3 * 1024 * 1024) return;
      const bytes = Buffer.from(envelope, "base64url");
      const packet = decodeBinaryTransportPacket(bytes) ?? JSON.parse(bytes.toString("utf8"));
      const friend = packet?.id === this.firstFriend && Boolean(this.firstFriend);

      if (!friend && (packet?.id !== this.firstOutgoing || this.forwarded || !this.firstOutgoing)) return;

      if (!(friend ? this.friendQueueId : this.firstQueueId) && result.status === 202 && result.body.queued === true && typeof result.body.msgId === "string" &&
          /^[a-f0-9-]{36}$/.test(result.body.msgId)) {
        if (friend) this.friendQueueId = result.body.msgId; else this.firstQueueId = result.body.msgId;
        const failure = result.traces?.slice().reverse().find((trace) => trace.event === "onionController:forward:fail");
        const networkStage = probeNetworkStages.find((stage) => stage === failure?.networkStage) ?? "unknown";
        cold.mark("p2p.queue.enqueued", { ...(friend ? { messageKind: "friend" as const } : {}), outcome: "queued", errorCode: getTorProbeErrorCode(result.body.error),
          networkStage, durationMs: typeof failure?.durationMs === "number" ? failure.durationMs : undefined,
          workerSlotsUsed: typeof failure?.slotsUsedAtStart === "number" ? failure.slotsUsedAtStart : undefined });

        return;
      }

      if (result.status !== 200 || result.body.ok !== true || result.body.forwarded !== true || result.body.via !== "tor") return;

      if (!friend) this.forwarded = true;
      const success = result.traces?.slice().reverse().find((trace) => trace.event === "onionController:forward:ok");
      cold.mark("p2p.native_forwarded", { ...(friend ? { messageKind: "friend" as const } : {}), outcome: "ok",
        durationMs: typeof success?.durationMs === "number" ? success.durationMs : undefined,
        workerSlotsUsed: typeof success?.slotsUsedAtStart === "number" ? success.slotsUsedAtStart : undefined });
    } catch { /* Unknown packet formats cannot establish this milestone. */ }
  }
}
