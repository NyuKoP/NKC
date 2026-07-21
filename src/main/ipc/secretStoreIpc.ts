import { ipcMain } from "electron";
import {
  isSecretStoreAvailable,
  loadKeyPair,
  removeKeyPair,
  saveKeyPair,
} from "../services/secretStore";
import type { AssertTrustedIpcSender } from "./types";

export const registerSecretStoreIpc = (assertTrustedIpcSender: AssertTrustedIpcSender) => {
  ipcMain.handle("secretStore:get", async (event, key: string) => {
    assertTrustedIpcSender(event);
    return loadKeyPair(key);
  });
  ipcMain.handle("secretStore:set", async (event, key: string, value: string) => {
    assertTrustedIpcSender(event);
    return saveKeyPair(key, value);
  });
  ipcMain.handle("secretStore:remove", async (event, key: string) => {
    assertTrustedIpcSender(event);
    return removeKeyPair(key);
  });
  ipcMain.handle("secretStore:isAvailable", async (event) => {
    assertTrustedIpcSender(event);
    return isSecretStoreAvailable();
  });
};
