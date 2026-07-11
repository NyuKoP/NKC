import type { ConnectionManagerState } from "../sync/connectionManager";

export const P2P_CONNECTION_STATUS_CHANNEL = "p2p:connection-status";

export type P2PConnectionStatusPayload = {
  convId: string;
  state: ConnectionManagerState;
  detail?: string;
  changedAt: number;
};

export type WebContentsLike = {
  isDestroyed?: () => boolean;
  send: (channel: string, payload: P2PConnectionStatusPayload) => void;
};

export type BrowserWindowLike = {
  webContents: WebContentsLike;
};

export const createP2PMainStatePublisher =
  (getWindows: () => BrowserWindowLike[], now: () => number = () => Date.now()) =>
  (convId: string, state: ConnectionManagerState, detail?: string) => {
    const payload: P2PConnectionStatusPayload = {
      convId,
      state,
      detail,
      changedAt: now(),
    };
    for (const window of getWindows()) {
      if (window.webContents.isDestroyed?.()) continue;
      window.webContents.send(P2P_CONNECTION_STATUS_CHANNEL, payload);
    }
  };
