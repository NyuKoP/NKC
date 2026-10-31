import { useAppStore } from "../../app/store";
import { useInternalOnionRouteStore } from "../../stores/internalOnionRouteStore";
import { getOrCreateDeviceId } from "../../security/deviceRole";
import { onAccountOwnerChange } from "../../accounts/accountOwnerLifecycle";
import { onVaultKeyChange } from "../../crypto/sessionKeyring";
import type { NetConfig } from "../netConfig";
import { InternalOnionRouteManager } from "./routeManager";
import { registerInternalOnionControlHandlers, sendControlPlaneMessage } from "./relayNetwork";

const DISCOVERY_INTERVAL_MS = 30_000;

const resolveLocalPeerId = () => {
  return getOrCreateDeviceId();
};

export const getDiscoveredRelayPeerIds = () => {
  const state = useAppStore.getState();
  const localPeerId = resolveLocalPeerId();

  const relayPeerIds = state.friends
    .filter((friend) => friend.friendStatus !== "blocked" && friend.friendStatus !== "deleted")
    .map((friend) => {
      const primary = typeof friend.primaryDeviceId === "string" ? friend.primaryDeviceId.trim() : "";
      const device = typeof friend.deviceId === "string" ? friend.deviceId.trim() : "";
      return primary || device;
    })
    .filter((peerId) => Boolean(peerId) && peerId !== localPeerId);

  return Array.from(new Set(relayPeerIds));
};

const manager = new InternalOnionRouteManager({
  getRelayPeerIds: getDiscoveredRelayPeerIds,
  getLocalPeerId: resolveLocalPeerId,
  onStateChange: (route) => {
    useInternalOnionRouteStore.getState().setRouteState(route);
  },
  emitControlPlane: (message) => {
    void sendControlPlaneMessage(message).catch((error) => {
      console.warn("[internal-onion] control-plane send failed", {
        type: message.type,
        circuitId: message.circuitId,
        hopIndex: message.hopIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },
});

registerInternalOnionControlHandlers({
  onAck: (message) => manager.handleHelloAck(message),
  onPong: (message, signerPeerId) => manager.handlePingPong(message, signerPeerId),
});

let desiredHopsCache = useInternalOnionRouteStore.getState().route.desiredHops;

let activeByConfig = false;

let discoveryTimer: ReturnType<typeof setInterval> | null = null;

const scheduleDiscovery = () => {
  if (discoveryTimer) return;
  discoveryTimer = setInterval(() => {
    if (!activeByConfig || !manager.isRunning()) return;
    const discoveredRelayCount = getDiscoveredRelayPeerIds().length;

    if (!discoveredRelayCount) return;
    const route = useInternalOnionRouteStore.getState().route;

    if (route.status === "building" || route.status === "rebuilding") return;

    if (route.status === "ready") {
      if (route.establishedHops >= route.desiredHops) return;

      if (discoveredRelayCount <= route.establishedHops) return;
    }

    void manager.rebuildRoute("RELAY_DISCOVERY_REFRESH");
  }, DISCOVERY_INTERVAL_MS);
};

const clearDiscovery = () => {
  if (!discoveryTimer) return;
  clearInterval(discoveryTimer);
  discoveryTimer = null;
};

export const getInternalOnionRouteManager = () => manager;

export const stopInternalOnionRouteRuntime = (status: "idle" | "expired" = "idle") => {
  activeByConfig = false;
  clearDiscovery();
  manager.stop(status);
};

onAccountOwnerChange(() => stopInternalOnionRouteRuntime());

onVaultKeyChange(() => stopInternalOnionRouteRuntime());

export const syncInternalOnionRouteRuntimeWithConfig = (config: NetConfig) => {
  const desiredHops = Math.max(1, Math.floor(config.selfOnionMinRelays));

  if (desiredHops !== desiredHopsCache) {
    desiredHopsCache = desiredHops;
    useInternalOnionRouteStore.getState().setDesiredHops(desiredHops);
  }

  const shouldRun = config.mode === "selfOnion" && config.selfOnionEnabled;
  activeByConfig = shouldRun;

  if (!shouldRun) {
    stopInternalOnionRouteRuntime("idle");

    return;
  }

  scheduleDiscovery();
  void manager.start(desiredHops);
};
