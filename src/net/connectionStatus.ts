import type { TransportState } from "../adapters/transports/types";
import type { TransportKind } from "./router";

export type ConnectionStatus = {
  state: TransportState;
  transport?: TransportKind;
};

type Listener = (status: ConnectionStatus) => void;

let current: ConnectionStatus = { state: "idle" };
const listeners = new Set<Listener>();

export const getConnectionStatus = () => current;

export const onConnectionStatus = (listener: Listener) => {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
};

export const updateConnectionStatus = (
  state: TransportState,
  transport?: TransportKind
) => {
  if (current.state === state && current.transport === transport) return;
  current = { state, transport };
  listeners.forEach((listener) => listener(current));
};
