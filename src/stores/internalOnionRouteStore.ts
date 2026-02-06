import { create } from "zustand";
import type { InternalOnionRouteState, InternalOnionRouteStatus } from "../net/internalOnion/types";

const DEFAULT_DESIRED_HOPS = 3;

const createInitialRouteState = (desiredHops = DEFAULT_DESIRED_HOPS): InternalOnionRouteState => ({
  desiredHops,
  establishedHops: 0,
  status: "idle",
  hops: Array.from({ length: desiredHops }, (_value, index) => ({
    hopIndex: index + 1,
    status: "pending",
  })),
  updatedAtTs: Date.now(),
});

const statusLabelMapKo: Record<InternalOnionRouteStatus, string> = {
  idle: "대기",
  building: "대기",
  rebuilding: "재구성중",
  ready: "연결됨",
  degraded: "불안정",
  expired: "대기",
};

const statusLabelMapEn: Record<InternalOnionRouteStatus, string> = {
  idle: "idle",
  building: "pending",
  rebuilding: "rebuilding",
  ready: "connected",
  degraded: "degraded",
  expired: "idle",
};

type InternalOnionRouteStoreState = {
  route: InternalOnionRouteState;
  setRouteState: (next: InternalOnionRouteState) => void;
  patchRouteState: (patch: Partial<InternalOnionRouteState>) => void;
  setDesiredHops: (desiredHops: number) => void;
  resetRouteState: (desiredHops?: number) => void;
};

export const useInternalOnionRouteStore = create<InternalOnionRouteStoreState>((set) => ({
  route: createInitialRouteState(),
  setRouteState: (next) => set({ route: next }),
  patchRouteState: (patch) =>
    set((current) => ({
      route: {
        ...current.route,
        ...patch,
      },
    })),
  setDesiredHops: (desiredHops) =>
    set((current) => {
      const nextDesired = Math.max(1, Math.floor(desiredHops));
      if (current.route.desiredHops === nextDesired) return current;
      return {
        route: {
          ...current.route,
          desiredHops: nextDesired,
          establishedHops: Math.min(current.route.establishedHops, nextDesired),
          hops: Array.from({ length: nextDesired }, (_value, index) => {
            const previous = current.route.hops[index];
            return (
              previous ?? {
                hopIndex: index + 1,
                status: "pending",
              }
            );
          }),
          updatedAtTs: Date.now(),
        },
      };
    }),
  resetRouteState: (desiredHops) => set({ route: createInitialRouteState(desiredHops) }),
}));

export const getRouteStatusText = (
  state: InternalOnionRouteState = useInternalOnionRouteStore.getState().route,
  language: "ko" | "en" = "ko"
) => {
  const map = language === "en" ? statusLabelMapEn : statusLabelMapKo;
  const prefix = language === "en" ? "Route" : "경로";
  return `${prefix}: ${map[state.status]}`;
};

export const getHopsProgressText = (
  state: InternalOnionRouteState = useInternalOnionRouteStore.getState().route
) => `hops: ${state.establishedHops}/${state.desiredHops}`;
