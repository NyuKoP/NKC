import type {
  HopAckMessage,
  HopHelloMessage,
  HopPingMessage,
  HopPongMessage,
  InternalOnionControlPlaneMessage,
  InternalOnionHopState,
  InternalOnionRouteState,
  InternalOnionRouteStatus,
} from "./types";

type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

type SetTimeoutFn = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutFn = (timeout: TimeoutHandle) => void;
type SetIntervalFn = (callback: () => void, delayMs: number) => IntervalHandle;
type ClearIntervalFn = (interval: IntervalHandle) => void;

type PendingAck = {
  peerId: string;
  resolve: (message: HopAckMessage) => void;
  reject: (error: Error) => void;
  timeout: TimeoutHandle;
};

type PendingPing = {
  sentTs: number;
  misses: number;
};

export const DEFAULT_REBUILD_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
] as const;

const DEFAULT_HELLO_ACK_TIMEOUT_MS = 4_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_KEEPALIVE_MISS_LIMIT = 2;
const MIN_CIRCUIT_BYTES = 16;
const MIN_HOPS = 1;
const MAX_HOPS = 6;

const clampDesiredHops = (value: number) => Math.max(MIN_HOPS, Math.min(MAX_HOPS, Math.floor(value)));

const dedupePeerIds = (peerIds: string[]) => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of peerIds) {
    const peerId = raw.trim();
    if (!peerId || seen.has(peerId)) continue;
    seen.add(peerId);
    unique.push(peerId);
  }
  return unique;
};

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const defaultRandomBytes = (size: number) => {
  const bytes = new Uint8Array(size);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
};

const createHops = (desiredHops: number, peerIds: string[]): InternalOnionHopState[] =>
  Array.from({ length: desiredHops }, (_value, index) => ({
    hopIndex: index + 1,
    peerId: peerIds[index],
    status: "pending",
  }));

const computeEstablishedHops = (hops: InternalOnionHopState[]) =>
  hops.reduce((count, hop) => count + (hop.status === "ok" ? 1 : 0), 0);

export type InternalOnionRouteManagerOptions = {
  getRelayPeerIds: () => string[];
  getLocalPeerId: () => string;
  onStateChange: (state: InternalOnionRouteState) => void;
  emitControlPlane?: (message: InternalOnionControlPlaneMessage) => void;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  helloAckTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveMissLimit?: number;
  rebuildBackoffMs?: number[];
};

export class InternalOnionRouteManager {
  private readonly getRelayPeerIds: () => string[];
  private readonly getLocalPeerId: () => string;
  private readonly emitState: (state: InternalOnionRouteState) => void;
  private readonly emitControlPlane?: (message: InternalOnionControlPlaneMessage) => void;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly setIntervalFn: SetIntervalFn;
  private readonly clearIntervalFn: ClearIntervalFn;
  private readonly helloAckTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveMissLimit: number;
  private readonly rebuildBackoffMs: number[];

  private running = false;
  private desiredHops = 3;
  private routeState: InternalOnionRouteState;
  private currentCircuitId: string | null = null;
  private keepaliveTimer: IntervalHandle | null = null;
  private rebuildTimer: TimeoutHandle | null = null;
  private rebuildBackoffIndex = 0;
  private pendingHelloAcks = new Map<number, PendingAck>();
  private pendingPings = new Map<number, PendingPing>();

  constructor(options: InternalOnionRouteManagerOptions) {
    this.getRelayPeerIds = options.getRelayPeerIds;
    this.getLocalPeerId = options.getLocalPeerId;
    this.emitState = options.onStateChange;
    this.emitControlPlane = options.emitControlPlane;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timeout) => clearTimeout(timeout));
    this.setIntervalFn =
      options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((interval) => clearInterval(interval));
    this.helloAckTimeoutMs = Math.max(500, options.helloAckTimeoutMs ?? DEFAULT_HELLO_ACK_TIMEOUT_MS);
    this.keepaliveIntervalMs = Math.max(
      1_000,
      options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    );
    this.keepaliveMissLimit = Math.max(
      0,
      options.keepaliveMissLimit ?? DEFAULT_KEEPALIVE_MISS_LIMIT
    );
    this.rebuildBackoffMs =
      options.rebuildBackoffMs && options.rebuildBackoffMs.length
        ? options.rebuildBackoffMs.map((value) => Math.max(1_000, value))
        : [...DEFAULT_REBUILD_BACKOFF_MS];
    const initialTs = this.now();
    this.routeState = {
      desiredHops: this.desiredHops,
      establishedHops: 0,
      status: "idle",
      hops: createHops(this.desiredHops, []),
      updatedAtTs: initialTs,
    };
    this.emitState(this.routeState);
  }

  isRunning() {
    return this.running;
  }

  getState() {
    return this.routeState;
  }

  async start(desiredHops = this.desiredHops) {
    const nextDesiredHops = clampDesiredHops(desiredHops);
    const desiredChanged = nextDesiredHops !== this.desiredHops;
    this.desiredHops = nextDesiredHops;
    this.running = true;
    if (!desiredChanged && this.routeState.status === "ready") {
      this.startKeepaliveLoop();
      return true;
    }
    return this.buildRoute(nextDesiredHops);
  }

  stop(nextStatus: "idle" | "expired" = "idle") {
    this.running = false;
    this.currentCircuitId = null;
    this.rebuildBackoffIndex = 0;
    this.clearKeepaliveLoop();
    this.clearRebuildTimer();
    this.clearPendingHelloAcks("ROUTE_STOPPED");
    this.pendingPings.clear();
    const routeState: InternalOnionRouteState = {
      desiredHops: this.desiredHops,
      establishedHops: 0,
      status: nextStatus,
      hops: createHops(this.desiredHops, []),
      updatedAtTs: this.now(),
    };
    this.setRouteState(routeState);
  }

  async buildRoute(desiredHops = this.desiredHops) {
    return this.buildRouteInternal({
      desiredHops: clampDesiredHops(desiredHops),
      rebuilding: false,
      failureReason: "BUILD_FAILED",
    });
  }

  async rebuildRoute(reason = "REBUILD_REQUESTED") {
    if (!this.running) return false;
    this.clearRebuildTimer();
    this.updateRouteState((current) => ({
      ...current,
      status: "rebuilding",
      updatedAtTs: this.now(),
      lastError: reason,
    }));
    return this.buildRouteInternal({
      desiredHops: this.desiredHops,
      rebuilding: true,
      failureReason: reason,
    });
  }

  handleHelloAck(message: HopAckMessage) {
    if (message.type !== "HOP_ACK") return;
    if (!this.currentCircuitId || message.circuitId !== this.currentCircuitId) return;
    // TODO: verify Ed25519 signature for relay identities when signing keys are available.
    const pending = this.pendingHelloAcks.get(message.hopIndex);
    if (!pending) return;
    this.clearTimeoutFn(pending.timeout);
    this.pendingHelloAcks.delete(message.hopIndex);
    if (!message.ok) {
      pending.reject(new Error("HOP_ACK_REJECTED"));
      return;
    }
    if (message.relayPeerId !== pending.peerId) {
      pending.reject(new Error("HOP_ACK_PEER_MISMATCH"));
      return;
    }
    pending.resolve(message);
  }

  handlePingPong(message: HopPongMessage) {
    if (message.type !== "HOP_PONG") return;
    if (!this.currentCircuitId || message.circuitId !== this.currentCircuitId) return;
    const pending = this.pendingPings.get(message.hopIndex);
    if (!pending) return;
    this.pendingPings.delete(message.hopIndex);
    const rttMs = Math.max(0, this.now() - pending.sentTs);
    this.updateRouteState((current) => {
      const hops: InternalOnionHopState[] = current.hops.map((item): InternalOnionHopState =>
        item.hopIndex === message.hopIndex
          ? {
              ...item,
              status: "ok" as const,
              lastSeenTs: message.ts,
              rttMs,
            }
          : item
      );
      return {
        ...current,
        establishedHops: computeEstablishedHops(hops),
        hops,
        updatedAtTs: this.now(),
      };
    });
  }

  private async buildRouteInternal(options: {
    desiredHops: number;
    rebuilding: boolean;
    failureReason: string;
  }) {
    const desiredHops = clampDesiredHops(options.desiredHops);
    this.desiredHops = desiredHops;
    this.clearKeepaliveLoop();
    this.clearPendingHelloAcks("BUILD_REPLACED");
    this.pendingPings.clear();

    const allPeers = dedupePeerIds(this.getRelayPeerIds());
    const localPeerId = this.getLocalPeerId().trim();
    const selectedPeerIds = allPeers.filter((peerId) => peerId !== localPeerId).slice(0, desiredHops);
    if (selectedPeerIds.length < desiredHops) {
      const waitingState: InternalOnionRouteState = {
        desiredHops,
        establishedHops: 0,
        status: "idle",
        hops: createHops(desiredHops, selectedPeerIds),
        lastError: "NO_RELAY_PEERS",
        updatedAtTs: this.now(),
      };
      this.currentCircuitId = null;
      this.setRouteState(waitingState);
      this.scheduleRebuild("NO_RELAY_PEERS");
      return false;
    }

    const circuitId = this.createCircuitId();
    this.currentCircuitId = circuitId;
    const initialStatus: InternalOnionRouteStatus = options.rebuilding ? "rebuilding" : "building";
    this.setRouteState({
      desiredHops,
      establishedHops: 0,
      status: initialStatus,
      circuitId,
      hops: createHops(desiredHops, selectedPeerIds),
      updatedAtTs: this.now(),
    });

    for (let index = 0; index < selectedPeerIds.length; index += 1) {
      const hopIndex = index + 1;
      const peerId = selectedPeerIds[index];
      try {
        const ack = await this.sendHelloAndAwaitAck({
          circuitId,
          hopIndex,
          peerId,
        });
        this.updateRouteState((current) => {
          const hops: InternalOnionHopState[] = current.hops.map(
            (hop): InternalOnionHopState =>
            hop.hopIndex === hopIndex
              ? {
                  ...hop,
                  peerId: ack.relayPeerId,
                  status: "ok" as const,
                  lastSeenTs: ack.ts,
                }
              : hop
          );
          return {
            ...current,
            establishedHops: computeEstablishedHops(hops),
            hops,
            updatedAtTs: this.now(),
            lastError: undefined,
          };
        });
      } catch {
        this.updateRouteState((current) => {
          const hops: InternalOnionHopState[] = current.hops.map(
            (hop): InternalOnionHopState =>
            hop.hopIndex === hopIndex
              ? {
                  ...hop,
                  status: "dead" as const,
                }
              : hop
          );
          return {
            ...current,
            status: "degraded",
            establishedHops: computeEstablishedHops(hops),
            hops,
            lastError: options.failureReason,
            updatedAtTs: this.now(),
          };
        });
        this.scheduleRebuild(options.failureReason);
        return false;
      }
    }

    this.rebuildBackoffIndex = 0;
    this.setRouteState({
      desiredHops,
      establishedHops: desiredHops,
      status: "ready",
      circuitId,
      hops: this.routeState.hops.map(
        (hop): InternalOnionHopState => ({
          ...hop,
          status: "ok" as const,
        })
      ),
      updatedAtTs: this.now(),
    });
    this.startKeepaliveLoop();
    return true;
  }

  private async sendHelloAndAwaitAck(params: {
    circuitId: string;
    hopIndex: number;
    peerId: string;
  }) {
    const { circuitId, hopIndex, peerId } = params;
    const helloMessage: HopHelloMessage = {
      type: "HOP_HELLO",
      circuitId,
      hopIndex,
      ts: this.now(),
      senderPeerId: this.getLocalPeerId().trim() || "local",
      // TODO: attach Ed25519 signature when local control-plane signing key is wired.
    };

    const ack = await new Promise<HopAckMessage>((resolve, reject) => {
      const timeout = this.setTimeoutFn(() => {
        this.pendingHelloAcks.delete(hopIndex);
        reject(new Error("HOP_ACK_TIMEOUT"));
      }, this.helloAckTimeoutMs);
      this.pendingHelloAcks.set(hopIndex, { peerId, resolve, reject, timeout });
      this.emitControlPlane?.(helloMessage);
      if (!this.emitControlPlane) {
        this.handleHelloAck({
          type: "HOP_ACK",
          circuitId,
          hopIndex,
          ts: this.now(),
          relayPeerId: peerId,
          ok: true,
        });
      }
    });
    return ack;
  }

  private keepaliveTick() {
    if (!this.running) return;
    if (this.routeState.status !== "ready") return;
    if (!this.currentCircuitId) return;
    for (const hop of this.routeState.hops) {
      if (hop.status !== "ok" || !hop.peerId) continue;
      const pending = this.pendingPings.get(hop.hopIndex);
      const nextMisses = pending ? pending.misses + 1 : 0;
      if (nextMisses > this.keepaliveMissLimit) {
        this.pendingPings.delete(hop.hopIndex);
        this.clearKeepaliveLoop();
        this.updateRouteState((current) => {
          const hops: InternalOnionHopState[] = current.hops.map(
            (item): InternalOnionHopState =>
            item.hopIndex === hop.hopIndex
              ? {
                  ...item,
                  status: "dead" as const,
                }
              : item
          );
          return {
            ...current,
            status: "degraded",
            establishedHops: computeEstablishedHops(hops),
            hops,
            lastError: "KEEPALIVE_MISSED",
            updatedAtTs: this.now(),
          };
        });
        this.scheduleRebuild("KEEPALIVE_MISSED");
        return;
      }
      const pingMessage: HopPingMessage = {
        type: "HOP_PING",
        circuitId: this.currentCircuitId,
        hopIndex: hop.hopIndex,
        ts: this.now(),
      };
      this.pendingPings.set(hop.hopIndex, {
        sentTs: pingMessage.ts,
        misses: nextMisses,
      });
      this.emitControlPlane?.(pingMessage);
      if (!this.emitControlPlane) {
        this.handlePingPong({
          type: "HOP_PONG",
          circuitId: pingMessage.circuitId,
          hopIndex: pingMessage.hopIndex,
          ts: this.now(),
        });
      }
    }
  }

  private startKeepaliveLoop() {
    this.clearKeepaliveLoop();
    this.keepaliveTimer = this.setIntervalFn(() => this.keepaliveTick(), this.keepaliveIntervalMs);
  }

  private clearKeepaliveLoop() {
    if (!this.keepaliveTimer) return;
    this.clearIntervalFn(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private scheduleRebuild(reason: string) {
    if (!this.running) return;
    this.clearRebuildTimer();
    const delay =
      this.rebuildBackoffMs[Math.min(this.rebuildBackoffIndex, this.rebuildBackoffMs.length - 1)] ??
      this.rebuildBackoffMs[this.rebuildBackoffMs.length - 1];
    this.rebuildBackoffIndex = Math.min(
      this.rebuildBackoffIndex + 1,
      this.rebuildBackoffMs.length - 1
    );
    this.rebuildTimer = this.setTimeoutFn(() => {
      if (!this.running) return;
      this.updateRouteState((current) => ({
        ...current,
        status: "rebuilding",
        updatedAtTs: this.now(),
        lastError: reason,
      }));
      void this.buildRouteInternal({
        desiredHops: this.desiredHops,
        rebuilding: true,
        failureReason: reason,
      });
    }, delay);
  }

  private clearRebuildTimer() {
    if (!this.rebuildTimer) return;
    this.clearTimeoutFn(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  private clearPendingHelloAcks(errorCode: string) {
    for (const pending of this.pendingHelloAcks.values()) {
      this.clearTimeoutFn(pending.timeout);
      pending.reject(new Error(errorCode));
    }
    this.pendingHelloAcks.clear();
  }

  private createCircuitId() {
    return toHex(this.randomBytes(MIN_CIRCUIT_BYTES));
  }

  private setRouteState(nextState: InternalOnionRouteState) {
    this.routeState = nextState;
    this.emitState(nextState);
  }

  private updateRouteState(updater: (current: InternalOnionRouteState) => InternalOnionRouteState) {
    this.setRouteState(updater(this.routeState));
  }
}
