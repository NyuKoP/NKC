import { ipcMain } from "electron";
import {
  isSecretStoreAvailable,
  loadKeyPair,
  removeKeyPair,
  removeAccountSecrets,
  saveKeyPair,
  readNativeRatchetSnapshot,
  commitNativeRatchetState,
  getAccountSessionEvidence,
  loadSessionOwnedSecret,
  saveSessionOwnedSecret,
  removeSessionOwnedSecret,
} from "../services/secretStore";
import type { AssertTrustedIpcSender } from "./types";
import type { MainAccountSession } from "../../accounts/mainSessionTypes";
import type { AccountSessionAuthority } from "../accountSessionAuthority";

export const registerSecretStoreIpc = (assertTrustedIpcSender: AssertTrustedIpcSender, assertWriteAllowed?: () => void, nativeOwnerEnabled = false,
  sessions?: AccountSessionAuthority, onActivated?: (session: MainAccountSession, assertCurrent: () => void) => Promise<void>) => {
  if (sessions) {
    ipcMain.handle("accountSession:flushStorage", (event, session: MainAccountSession) => {
      assertTrustedIpcSender(event);
      sessions.assertCurrent(event.sender.id, session);
      event.sender.session.flushStorageData();
      sessions.assertCurrent(event.sender.id, session);
    });
    ipcMain.handle("accountSession:validate", (event, session: MainAccountSession) => {
      assertTrustedIpcSender(event);
      sessions.assertCurrent(event.sender.id, session);

      return true;
    });
    ipcMain.handle("accountSession:activate", async (event, accountId: string) => {
      assertTrustedIpcSender(event);
      const session = sessions.activate(event.sender.id, accountId);

      try {
        await getAccountSessionEvidence(session.accountId);
        sessions.assertCurrent(event.sender.id, session);
        await onActivated?.(session, () => { sessions.assertCurrent(event.sender.id, session); });

        return sessions.assertCurrent(event.sender.id, session);
      } catch (error) {
        sessions.cancelActivation(event.sender.id, session);
        throw error;
      }
    });
    ipcMain.handle("accountSession:revoke", (event) => {
      assertTrustedIpcSender(event);
      sessions.revoke(event.sender.id);
    });

    for (const operation of ["get", "set", "remove"] as const) {
      ipcMain.handle(`secretStore:owned:${operation}`, (event, session: MainAccountSession, key: string, value?: string,
        expected?: { value: string | null }) => {
        assertTrustedIpcSender(event);

        if (operation !== "get") assertWriteAllowed?.();

        const owner = { accountId: session?.accountId,
          assertCurrent: () => { sessions.assertCurrent(event.sender.id, session); } };

        owner.assertCurrent();

        return operation === "get" ? loadSessionOwnedSecret(key, owner)
          : operation === "set" ? saveSessionOwnedSecret(key, value!, owner, expected)
          : removeSessionOwnedSecret(key, owner);
      });
    }
  }

  ipcMain.handle("secretStore:get", async (event, key: string) => {
    assertTrustedIpcSender(event);

    return loadKeyPair(key);
  });
  ipcMain.handle("secretStore:set", async (event, key: string, value: string) => {
    assertTrustedIpcSender(event);
    assertWriteAllowed?.();

    return saveKeyPair(key, value);
  });
  ipcMain.handle("secretStore:remove", async (event, key: string) => {
    assertTrustedIpcSender(event);
    assertWriteAllowed?.();

    return removeKeyPair(key);
  });
  ipcMain.handle("secretStore:isAvailable", async (event) => {
    assertTrustedIpcSender(event);

    return isSecretStoreAvailable();
  });
  ipcMain.handle("secretStore:removeAccount", async (event, accountId: string, session?: MainAccountSession) => {
    assertTrustedIpcSender(event);
    assertWriteAllowed?.();

    const owner = session && sessions ? { accountId: session.accountId,
      assertCurrent: () => { sessions.assertCurrent(event.sender.id, session, accountId); } } : undefined;

    const result = await removeAccountSecrets(accountId, owner);

    if (result) sessions?.revokeAccount(accountId);

    return result;
  });

  if (nativeOwnerEnabled) {
    ipcMain.handle("secretStore:ratchetSnapshot", async (event, accountId: string, channel: string, version: 1 | 2) => {
      assertTrustedIpcSender(event);

      return readNativeRatchetSnapshot(accountId, channel, version);
    });
    ipcMain.handle("secretStore:ratchetCommit", async (event, request: Parameters<typeof commitNativeRatchetState>[0]) => {
      assertTrustedIpcSender(event);
      assertWriteAllowed?.();

      return commitNativeRatchetState(request);
    });
  }
};
