import type { Transport, TransportPacket, TransportState } from "./types";
import type { RouteController } from "../../net/routeController";
import { useNetConfigStore } from "../../net/netConfigStore";
import { getDiscoveredRelayPeerIds, getInternalOnionRouteManager, syncInternalOnionRouteRuntimeWithConfig } from "../../net/internalOnion/runtime";
import { useInternalOnionRouteStore } from "../../stores/internalOnionRouteStore";
import type { InternalOnionRouteState } from "../../net/internalOnion/types";
import { sendDataViaCurrentRoute } from "../../net/internalOnion/relayNetwork";

type Handler<T> = (payload: T) => void;

type SelfOnionOptions = {
  routeController: RouteController;
  relayPool?: string[];
};

const toTransportState = (routeStatus: InternalOnionRouteState["status"]): TransportState => {
  if (routeStatus === "ready") return "connected";
  if (routeStatus === "building" || routeStatus === "rebuilding") return "connecting";
  if (routeStatus === "degraded") return "degraded";
  return "failed";
};

export const createSelfOnionTransport = ({
  routeController,
  relayPool = [],
}: SelfOnionOptions): Transport => {
  let state: TransportState = "idle";
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];
  let routeUnsubscribe: (() => void) | null = null;
  const routeManager = getInternalOnionRouteManager();

  const emitState = (next: TransportState) => {
    if (state === next) return;
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  const reportRelayPool = () => {
    const discovered = getDiscoveredRelayPeerIds();
    const merged = Array.from(new Set([...relayPool, ...discovered]));
    routeController.reportRelayPoolSize(merged.length);
  };

  const syncFromRouteState = (route: InternalOnionRouteState) => {
    emitState(toTransportState(route.status));
    if (route.status === "degraded" || route.status === "idle" || route.status === "expired") {
      routeController.reportRouteBuildFail();
    }
  };

  return {
    name: "selfOnion",
    async start() {
      emitState("connecting");
      reportRelayPool();
      if (!routeUnsubscribe) {
        routeUnsubscribe = useInternalOnionRouteStore.subscribe((next, previous) => {
          if (next.route === previous.route) return;
          syncFromRouteState(next.route);
        });
      }
      const config = useNetConfigStore.getState().config;
      syncInternalOnionRouteRuntimeWithConfig(config);
      await routeManager.start(config.selfOnionMinRelays);
      syncFromRouteState(useInternalOnionRouteStore.getState().route);
    },
    async stop() {
      if (routeUnsubscribe) {
        routeUnsubscribe();
        routeUnsubscribe = null;
      }
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      const route = useInternalOnionRouteStore.getState().route;
      if (route.status !== "ready") {
        const error = new Error(
          "INTERNAL_ONION_NOT_READY: Internal onion route is not ready"
        ) as Error & { code?: string };
        error.code = "INTERNAL_ONION_NOT_READY";
        throw error;
      }
      await sendDataViaCurrentRoute(packet);
      const rttMs = route.hops.reduce((acc, hop) => Math.max(acc, hop.rttMs ?? 0), 0);
      ackHandlers.forEach((handler) => handler({ id: packet.id, rttMs }));
    },
    onMessage(cb) {
      messageHandlers.push(cb);
    },
    onAck(cb) {
      ackHandlers.push((payload) => cb(payload.id, payload.rttMs));
    },
    onState(cb) {
      stateHandlers.push(cb);
      cb(state);
    },
  };
};
