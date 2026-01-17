import type { OnionComponentState, OnionNetwork } from "./netConfig";

export type OnionRuntimeStatus = {
  status: "idle" | "starting" | "running" | "failed";
  network?: OnionNetwork;
  socksPort?: number;
  error?: string;
};

export type OnionStatus = {
  components: {
    tor: OnionComponentState;
    lokinet: OnionComponentState;
  };
  runtime: OnionRuntimeStatus;
};

type OnionBridge = {
  install: (payload: { network: OnionNetwork }) => Promise<void>;
  uninstall: (payload: { network: OnionNetwork }) => Promise<void>;
  setMode: (payload: { enabled: boolean; network: OnionNetwork }) => Promise<void>;
  status: () => Promise<OnionStatus>;
  checkUpdates: () => Promise<OnionStatus>;
  applyUpdate: (payload: { network: OnionNetwork }) => Promise<void>;
  onProgress: (cb: (payload: { network: OnionNetwork; status: OnionComponentState }) => void) => () => void;
};

const getBridge = (): OnionBridge | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { onion?: OnionBridge };
  return w.onion ?? null;
};

export const installOnion = async (network: OnionNetwork) => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  await bridge.install({ network });
};

export const uninstallOnion = async (network: OnionNetwork) => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  await bridge.uninstall({ network });
};

export const setOnionMode = async (enabled: boolean, network: OnionNetwork) => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  await bridge.setMode({ enabled, network });
};

export const getOnionStatus = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  return bridge.status();
};

export const checkOnionUpdates = async () => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  return bridge.checkUpdates();
};

export const applyOnionUpdate = async (network: OnionNetwork) => {
  const bridge = getBridge();
  if (!bridge) throw new Error("Onion bridge unavailable");
  await bridge.applyUpdate({ network });
};

export const onOnionProgress = (
  cb: (payload: { network: OnionNetwork; status: OnionComponentState }) => void
) => {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.onProgress(cb);
};
