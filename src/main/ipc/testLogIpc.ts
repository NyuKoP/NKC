import { app, ipcMain } from "electron";
import {
  appendTestLogRecord,
  getFriendFlowTestLogPath,
  getTestLogPath,
  type TestLogAppendPayload,
} from "../testLogStore";
import type { AssertTrustedIpcSender } from "./types";

export const registerTestLogIpc = (assertTrustedIpcSender: AssertTrustedIpcSender) => {
  ipcMain.handle("testLog:path", async (event) => {
    assertTrustedIpcSender(event);
    return getTestLogPath(app.getPath("userData"));
  });
  ipcMain.handle("testLog:friendFlowPath", async (event) => {
    assertTrustedIpcSender(event);
    return getFriendFlowTestLogPath(app.getPath("userData"));
  });
  ipcMain.handle("testLog:append", async (event, payload: TestLogAppendPayload) => {
    assertTrustedIpcSender(event);
    if (!payload || typeof payload !== "object") throw new Error("invalid-test-log-payload");
    if (typeof payload.channel !== "string" || !payload.channel.trim()) {
      throw new Error("invalid-test-log-channel");
    }
    const userDataPath = app.getPath("userData");
    await appendTestLogRecord(userDataPath, {
      channel: payload.channel.trim(),
      event: payload.event,
      at: payload.at,
    });
    return { ok: true, path: getTestLogPath(userDataPath) };
  });
};
