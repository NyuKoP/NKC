export type StartupStep = "verify_key" | "repair_text" | "list_profiles" | "restore_conversations";

export type DeliveryContext = { parentId?: string; deliveryPath: "direct" | "sync_response" | "relay" | "unknown" };

export type RendererColdMetric = {
  event: "p2p.user_send" | "p2p.peer_received" | "p2p.peer_stored" | "p2p.authenticated_read" | "p2p.transport_ack" | "renderer.startup_step" | "p2p.friend_send" | "p2p.diagnostic_select" | "p2p.receive_stage";
  rendererMs: number;
  durationMs?: number;
  initStage?: StartupStep;
  messageId?: string; // Local binding only; the main sink never serializes it.
  messageKind?: "chat" | "friend";
  parentId?: string; // Process-local packet/envelope relation, never serialized by the sink.
  deliveryPath?: DeliveryContext["deliveryPath"];
  conversationOpen?: boolean;
  deliveryStage?: "controller_received" | "controller_accepted" | "decoded" | "message_decoded" | "decode_failed" | "verified" | "decrypted" | "stored" | "refresh_requested" | "state_updated" | "rendered" | "displayed" | "duplicate_rejected" | "replay_rejected" | "failed";
};

type Bridge = { coldStartEnabled?: boolean; recordColdStartMetric?: (metric: RendererColdMetric) => Promise<unknown> };

/** Process-local identities stay in memory. Only fixed events and numeric timings leave this module. */
export class FirstMessageMeasurement {
  private outgoing: { id: string; conversation: string; at: number } | null = null;
  private incoming = new Map<string, number>();
  private stored = false;
  private incomingMessage: string | null = null;
  private confirmed = false;
  private acknowledged = false;
  private friendOutgoing: string | null = null;
  private packetBytes = new WeakMap<Uint8Array, string>();
  private storedContexts = new Map<string, DeliveryContext>();
  private uiObserved = new Map<string, Set<string>>();
  private readonly enabled: () => boolean;
  private readonly emit: (metric: RendererColdMetric) => void;
  private readonly now: () => number;
  constructor(enabled: () => boolean, emit: (metric: RendererColdMetric) => void, now = () => performance.now()) {
    this.enabled = enabled; this.emit = emit; this.now = now;
  }
  observing() { return this.enabled(); }
  userSend(id: string, conversation: string) {
    if (!this.enabled() || this.outgoing) return;
    this.outgoing = { id, conversation, at: this.now() };
    this.emit({ event: "p2p.user_send", rendererMs: this.outgoing.at, messageId: id });
  }
  received(id: string) {
    if (!this.enabled() || this.stored || this.incoming.has(id)) return;

    if (this.incoming.size >= 128) this.incoming.delete(this.incoming.keys().next().value!);
    this.incoming.set(id, this.now());
  }
  selectedOutgoingId(kind: "chat" | "friend" = "chat") { return kind === "chat" ? this.outgoing?.id ?? null : this.friendOutgoing; }
  friendSend(id: string) {
    if (!this.enabled() || this.friendOutgoing) return;
    this.friendOutgoing = id;
    this.emit({ event: "p2p.friend_send", rendererMs: this.now(), messageId: id });
  }
  bindPacketBytes(bytes: Uint8Array, parentId: string) {
    if (this.enabled()) this.packetBytes.set(bytes, parentId);
  }
  packetContext(bytes: Uint8Array): DeliveryContext {
    return { parentId: this.packetBytes.get(bytes), deliveryPath: "sync_response" };
  }
  stage(id: string, deliveryStage: RendererColdMetric["deliveryStage"], context?: DeliveryContext, conversationOpen?: boolean) {
    if (!this.enabled()) return;

    if (deliveryStage === "stored" && !this.storedContexts.has(id)) {
      if (this.storedContexts.size >= 128) {
        const oldest = this.storedContexts.keys().next().value!;
        this.storedContexts.delete(oldest); this.uiObserved.delete(oldest);
      }

      this.storedContexts.set(id, context ?? { deliveryPath: "unknown" });
    }

    this.emit({ event: "p2p.receive_stage", rendererMs: this.now(), messageId: id, deliveryStage,
      ...context, ...(conversationOpen === undefined ? {} : { conversationOpen }) });
  }
  uiStage(ids: Iterable<string> | null, deliveryStage: "refresh_requested" | "state_updated" | "rendered", selectedConversationIds?: Set<string>) {
    if (!this.enabled()) return;

    for (const id of ids ?? this.storedContexts.keys()) {
      const context = this.storedContexts.get(id);

      if (!context) continue; // Existing history is not a newly observed receive.
      const seen = this.uiObserved.get(id) ?? new Set<string>();

      if (seen.has(deliveryStage)) continue;
      seen.add(deliveryStage); this.uiObserved.set(id, seen);
      this.stage(id, deliveryStage, context, selectedConversationIds?.has(id));
    }
  }
  renderedIn(root: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> } | null) {
    if (!this.enabled() || !root) return;
    const ids = Array.from(root.querySelectorAll("[data-msg-id]"), node => node.getAttribute("data-msg-id")!).filter(Boolean);
    // DOM commit in the open conversation, not viewport visibility or harness observation.
    this.uiStage(ids, "rendered", new Set(ids));
  }
  messageAuthenticated(id: string) {
    if (!this.enabled() || this.incomingMessage) return;
    const at = this.incoming.get(id);

    if (at === undefined) return; // Never invent a receive observation.
    this.incomingMessage = id;
    this.emit({ event: "p2p.peer_received", rendererMs: at });
  }
  messageStored(id: string) {
    if (!this.enabled() || this.stored || this.incomingMessage !== id) return;
    const at = this.incoming.get(id);

    if (at === undefined) return;
    this.stored = true;
    const completed = this.now();
    this.emit({ event: "p2p.peer_stored", rendererMs: completed, durationMs: completed - at });
    this.incoming.clear();
  }
  transportAck(id: string) {
    if (!this.enabled() || !this.outgoing || this.outgoing.id !== id || this.acknowledged) return;
    this.acknowledged = true;
    this.emit({ event: "p2p.transport_ack", rendererMs: this.now(), durationMs: this.now() - this.outgoing.at });
  }
  authenticatedRead(conversation: string, anchor: unknown) {
    if (!this.enabled() || !this.outgoing || this.confirmed ||
        this.outgoing.conversation !== conversation || this.outgoing.id !== anchor) return;
    this.confirmed = true;
    this.emit({ event: "p2p.authenticated_read", rendererMs: this.now(), durationMs: this.now() - this.outgoing.at });
  }
}

const bridge = () => (globalThis as { nkc?: Bridge }).nkc;

const enabled = () => bridge()?.coldStartEnabled === true;

const emit = (metric: RendererColdMetric) => {
  try { void bridge()?.recordColdStartMetric?.(metric).catch(() => {}); } catch { /* Measurement never blocks the app. */ }
};

export const firstMessageMeasurement = new FirstMessageMeasurement(enabled, emit);

const observedSteps = new Set<StartupStep>();

export const measureStartupStep = async <T>(stage: StartupStep, work: () => Promise<T>): Promise<T> => {
  if (!enabled() || observedSteps.has(stage)) return work();
  observedSteps.add(stage);
  const at = performance.now();

  try { return await work(); }
  finally { emit({ event: "renderer.startup_step", initStage: stage, rendererMs: performance.now(), durationMs: performance.now() - at }); }
};
