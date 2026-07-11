import { create } from "zustand";
import type { ConnectionManagerState } from "../sync/connectionManager";

export type P2PConnectionHealth =
  | "idle"
  | "connecting"
  | "online"
  | "degraded"
  | "offline";

export type P2PConnectionSnapshot = {
  convId: string;
  state: ConnectionManagerState;
  health: P2PConnectionHealth;
  connected: boolean;
  detail?: string;
  lastChangedAt: number;
};

export type P2PConnectionStatusPayload = {
  convId: string;
  state: ConnectionManagerState;
  detail?: string;
  changedAt?: number;
};

export type P2PStoreState = {
  connectionsByConvId: Record<string, P2PConnectionSnapshot>;
  setConnectionState: (
    convId: string,
    state: ConnectionManagerState,
    detail?: string,
    changedAt?: number
  ) => void;
  removeConnectionState: (convId: string) => void;
  resetConnectionStates: () => void;
};

type P2PConnectionStatusBridge = {
  onConnectionStatus: (cb: (payload: unknown) => void) => () => void;
};

const CONNECTION_STATES = new Set<ConnectionManagerState>([
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "closed",
]);

export const resolveP2PConnectionHealth = (
  state: ConnectionManagerState
): P2PConnectionHealth => {
  if (state === "connected") return "online";
  if (state === "connecting") return "connecting";
  if (state === "reconnecting") return "degraded";
  if (state === "closed") return "offline";
  return "idle";
};

export const useP2PStore = create<P2PStoreState>((set) => ({
  connectionsByConvId: {},
  setConnectionState: (convId, state, detail, changedAt = Date.now()) =>
    set((current) => ({
      connectionsByConvId: {
        ...current.connectionsByConvId,
        [convId]: {
          convId,
          state,
          health: resolveP2PConnectionHealth(state),
          connected: state === "connected",
          detail,
          lastChangedAt: changedAt,
        },
      },
    })),
  removeConnectionState: (convId) =>
    set((current) => {
      const remaining = { ...current.connectionsByConvId };
      delete remaining[convId];
      return { connectionsByConvId: remaining };
    }),
  resetConnectionStates: () => set({ connectionsByConvId: {} }),
}));

export const createP2PConnectionStatePublisher =
  (now: () => number = () => Date.now()) =>
  (convId: string, state: ConnectionManagerState, detail?: string) => {
    useP2PStore.getState().setConnectionState(convId, state, detail, now());
  };

export const applyP2PConnectionStatus = (payload: P2PConnectionStatusPayload) => {
  useP2PStore
    .getState()
    .setConnectionState(payload.convId, payload.state, payload.detail, payload.changedAt);
};

export const getP2PConnectionSnapshot = (convId: string) =>
  useP2PStore.getState().connectionsByConvId[convId] ?? null;

export const isP2PConnectionStatusPayload = (
  payload: unknown
): payload is P2PConnectionStatusPayload => {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<P2PConnectionStatusPayload>;
  return (
    typeof candidate.convId === "string" &&
    CONNECTION_STATES.has(candidate.state as ConnectionManagerState) &&
    (candidate.detail === undefined || typeof candidate.detail === "string") &&
    (candidate.changedAt === undefined || typeof candidate.changedAt === "number")
  );
};

const getP2PConnectionStatusBridge = (): P2PConnectionStatusBridge | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { p2p?: P2PConnectionStatusBridge }).p2p ?? null;
};

export const bindP2PConnectionStatusBridge = (
  bridge: P2PConnectionStatusBridge | null = getP2PConnectionStatusBridge()
) => {
  if (!bridge) return () => {};
  return bridge.onConnectionStatus((payload) => {
    if (!isP2PConnectionStatusPayload(payload)) return;
    applyP2PConnectionStatus(payload);
  });
};
