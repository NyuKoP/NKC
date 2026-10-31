import { ipcMain } from "electron";
import type {
  OfflineQueueManager,
  P2PFriendRoute,
} from "../nativeOfflineQueueManager";
import type { AssertTrustedIpcSender } from "./types";
import { decodeBinaryTransportPacketV2, encodeInboxTransportPacket } from "../../adapters/transports/packetCodec";
import { encodeBase64Url } from "../../security/base64url";
import { validateLocalAccountId, type AccountSessionAuthority } from "../accountSessionAuthority";
import type { MainAccountSession } from "../../accounts/mainSessionTypes";
import type { NativeWorkerClient } from "../nativeWorkerClient";
import { ownedBinaryRetryId, ownedRetryId } from "../socksHttpClient";
import { ONION_TRANSFER_MAX_BODY_BYTES } from "../../net/mediaTransferLimits";

type RegisterP2PQueueIpcOptions = {
  assertTrustedIpcSender: AssertTrustedIpcSender;
  getQueueManager: () => OfflineQueueManager | null;
  getNativeWorkerClient?: () => NativeWorkerClient | null;
  experimentalUnifiedText?: boolean;
  sessions: AccountSessionAuthority;
};

const isP2PFriendRoute = (item: unknown): item is P2PFriendRoute =>
  item !== null &&
  typeof item === "object" &&
  "friendId" in item &&
  typeof item.friendId === "string" &&
  "onionAddress" in item &&
  typeof item.onionAddress === "string";

const isP2PFriendRouteArray = (payload: unknown): payload is P2PFriendRoute[] =>
  Array.isArray(payload) && payload.every(isP2PFriendRoute);

const isAccountId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+$/.test(value);

export const registerP2PQueueIpc = (options: RegisterP2PQueueIpcOptions) => {
  ipcMain.handle("nkc:nativeQueueInstance", (event, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    options.sessions.assertCurrent(event.sender.id, session);

    return options.getNativeWorkerClient?.()?.getInstanceId();
  });

  for (const [channel, method] of [["nkc:confirmOnionApplicationReceipt", "queue.confirmApplication"],
    ["nkc:cancelOnionApplicationRetry", "queue.cancelApplication"],
    ["nkc:supersedeOnionApplicationRetry", "queue.supersedeApplication"]]) {
    ipcMain.handle(channel, async (event, session: MainAccountSession, messageId: unknown, ciphertext: unknown) => {
      options.assertTrustedIpcSender(event);
      const owner = options.sessions.assertCurrent(event.sender.id, session), client = options.getNativeWorkerClient?.();

      if (!client || typeof messageId !== "string" || !messageId || messageId.length > 256) return false;
      let id: string;

      if (ciphertext instanceof Uint8Array) {
        if (ciphertext.byteLength > ONION_TRANSFER_MAX_BODY_BYTES) return false;

        // Own IPC bytes before awaiting the worker; never accept a renderer-supplied retry ID.
        const bytes = ciphertext.slice();

        try {
          const packet = decodeBinaryTransportPacketV2(bytes);

          if (packet.id !== messageId || !(packet.payload instanceof Uint8Array)) return false;
        } catch { return false; }

        id = ownedBinaryRetryId(bytes);
      } else {
        if (typeof ciphertext !== "string" || !ciphertext || ciphertext.length > 16 * 1024 * 1024) return false;

        id = ownedRetryId(messageId, ciphertext);
      }

      await client.request(method, { accountId: owner.accountId, id });
      options.sessions.assertCurrent(event.sender.id, session);

      return true;
    });
  }
  const captureOwner = (event: Electron.IpcMainInvokeEvent, candidate: MainAccountSession, accountId?: string) => {
    const rendererId = event.sender.id;
    const session = options.sessions.assertCurrent(rendererId, candidate, accountId);

    return { accountId: session.accountId, sessionToken: session.token,
      assertCurrent: () => { options.sessions.assertCurrent(rendererId, session); } };
  };
  ipcMain.handle("p2pQueue:phase2iTestProxy", async (event, url: unknown, nonblockingWake?: unknown) => {
    options.assertTrustedIpcSender(event);

    if (!options.experimentalUnifiedText) return { ok: false, error: "experiment-blocked" };
    const manager = options.getQueueManager();

    if (!manager || typeof url !== "string") return { ok: false };

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== "socks5:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username ||
          parsed.password || (parsed.pathname && parsed.pathname !== "/")) return { ok: false };
      await manager.updateProxyUrl(url, nonblockingWake !== true);

      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle("p2pQueue:handoffUnified", async (event, value: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);

    if (!options.experimentalUnifiedText) return { ok: false, error: "experiment-blocked" };
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

    if (!value || typeof value !== "object") return { ok: false, error: "invalid-handoff" };
    const p = value;
    const owner = captureOwner(event, session);

    if (!("accountId" in p) || !isAccountId(p.accountId) || p.accountId !== owner.accountId ||
        !("id" in p) || typeof p.id !== "string" || p.id.length === 0 || p.id.length > 128 ||
        !("friendId" in p) || typeof p.friendId !== "string" || p.friendId.length === 0 || p.friendId.length > 128 ||
        !("payload" in p) || typeof p.payload !== "string" || p.payload.length > 128 * 1024 ||
        !("inboxWriteToken" in p) || typeof p.inboxWriteToken !== "string" || p.inboxWriteToken.length > 256 || !p.inboxWriteToken ||
        !("onionAddress" in p) || typeof p.onionAddress !== "string" || !/^[a-z2-7]{56}\.onion$/.test(p.onionAddress)) {
      return { ok: false, error: "invalid-handoff" };
    }

    try {
      const packet = JSON.parse(p.payload);

      if (packet?.header?.eventId !== p.id || !/^phase2i:[a-zA-Z0-9_-]{43}$/.test(packet?.header?.convId ?? "") ||
          packet?.header?.rk?.v !== 2) return { ok: false, error: "invalid-handoff" };

      const item = await manager.enqueueMessage({ accountId: p.accountId, id: p.id,
        friendId: p.friendId, onionAddress: p.onionAddress,
        payload: encodeInboxTransportPacket({ id: p.id,
          payload: { b64: encodeBase64Url(new TextEncoder().encode(p.payload)) } }),
        inboxWriteToken: p.inboxWriteToken, immutable: true, sessionToken: owner.sessionToken }, owner.assertCurrent);
      owner.assertCurrent();

      return { ok: true, status: item.status };
    } catch {
      return { ok: false, error: "handoff-rejected" };
    }
  });
  ipcMain.handle("p2pQueue:setActiveAccount", async (event, accountId: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account" };
    const owner = captureOwner(event, session, accountId);
    await manager.setActiveAccount(owner.accountId, owner.assertCurrent, owner.sessionToken);
    owner.assertCurrent();

    return { ok: true };
  });

  ipcMain.handle("p2pQueue:removeAccount", async (event, accountId: unknown, managementSession: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account" };
    // A current Main session permits explicit cleanup of an inactive local account too.
    const owner = captureOwner(event, managementSession);
    await manager.removeAccount(validateLocalAccountId(accountId), owner.assertCurrent);
    owner.assertCurrent();

    return { ok: true };
  });

  ipcMain.handle("p2pQueue:clearPending", async (event, accountId: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable", removed: 0 };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account", removed: 0 };

    const owner = captureOwner(event, session, accountId);
    const removed = await manager.clearPending(owner.accountId, owner.assertCurrent);
    owner.assertCurrent();

    return { ok: true, removed };
  });

  ipcMain.handle("p2pQueue:setFriends", async (event, accountId: unknown, payload: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account" };

    if (!isP2PFriendRouteArray(payload)) return { ok: false, error: "invalid-friends" };
    const owner = captureOwner(event, session, accountId);
    await manager.setFriends(owner.accountId, payload, owner.assertCurrent);
    owner.assertCurrent();

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
      },
      session: MainAccountSession
    ) => {
      options.assertTrustedIpcSender(event);
      const manager = options.getQueueManager();

      if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

      if (!payload?.friendId || !payload.onionAddress || typeof payload.payload !== "string") {
        return { ok: false, error: "invalid-message" };
      }

      const owner = captureOwner(event, session);
      const message = await manager.enqueueMessage({
        accountId: owner.accountId,
        sessionToken: owner.sessionToken,
        id: payload.messageId,
        friendId: payload.friendId,
        onionAddress: payload.onionAddress,
        payload: payload.payload,
      }, owner.assertCurrent);
      owner.assertCurrent();

      return { ok: true, message };
    }
  );

  ipcMain.handle("p2pQueue:list", async (event, accountId: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable", messages: [] };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account", messages: [] };

    const owner = captureOwner(event, session, accountId);
    const messages = await manager.listMessages(owner.accountId, owner.assertCurrent);
    owner.assertCurrent();

    return { ok: true, messages };
  });

  ipcMain.handle("p2pQueue:flushNow", async (event, accountId: unknown, session: MainAccountSession) => {
    options.assertTrustedIpcSender(event);
    const manager = options.getQueueManager();

    if (!manager) return { ok: false, error: "p2p-queue-unavailable" };

    if (!isAccountId(accountId)) return { ok: false, error: "invalid-account" };
    const owner = captureOwner(event, session, accountId);
    await manager.flushNow(owner.accountId, owner.assertCurrent);
    owner.assertCurrent();

    return { ok: true };
  });
};
