import { ipcMain } from "electron";
import type {
  OfflineQueueManager,
  P2PFriendRoute,
} from "../nativeOfflineQueueManager";
import type { AssertTrustedIpcSender } from "./types";

type RegisterP2PQueueIpcOptions = {
  assertTrustedIpcSender: AssertTrustedIpcSender;
  getQueueManager: () => OfflineQueueManager | null;
};

const isP2PFriendRouteArray = (payload: unknown): payload is P2PFriendRoute[] =>
  Array.isArray(payload) &&
  payload.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof (item as P2PFriendRoute).friendId === "string" &&
      typeof (item as P2PFriendRoute).onionAddress === "string"
  );

export const registerP2PQueueIpc = (options: RegisterP2PQueueIpcOptions) => {
  ipcMain.handle("p2pQueue:setFriends", async (event, payload: unknown) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();
    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };
    if (!isP2PFriendRouteArray(payload)) return { ok: false, error: "invalid-friends" };
    await manager.setFriends(payload);
    return { ok: true };
  });

  ipcMain.handle(
    "p2pQueue:enqueue",
    async (
      event,
      payload: {
        friendId?: string;
        onionAddress?: string;
        messageId?: string;
        payload?: string;
      }
    ) => {
      options.assertTrustedIpcSender(event);
      const manager = options.getQueueManager();
      if (!manager) return { ok: false, error: "p2p-queue-unavailable" };
      if (!payload?.friendId || !payload.onionAddress || typeof payload.payload !== "string") {
        return { ok: false, error: "invalid-message" };
      }
      const message = await manager.enqueueMessage({
        id: payload.messageId,
        friendId: payload.friendId,
        onionAddress: payload.onionAddress,
        payload: payload.payload,
      });
      return { ok: true, message };
    }
  );

  ipcMain.handle("p2pQueue:list", async (event) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();
    if (!manager) return { ok: false, error: "p2p-queue-unavailable", messages: [] };
    return { ok: true, messages: await manager.listMessages() };
  });

  ipcMain.handle("p2pQueue:flushNow", async (event) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();
    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };
    await manager.flushNow();
    return { ok: true };
  });
};
