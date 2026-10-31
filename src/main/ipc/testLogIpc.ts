import { app, ipcMain } from "electron";
import {
  appendTestLogRecord,
  getFriendFlowTestLogPath,
  getTestLogPath,
  type TestLogAppendPayload,
} from "../testLogStore";
import type { AssertTrustedIpcSender } from "./types";
import { sanitizeDiagnosticRecord } from "../sanitizeDiagnosticRecord";

export const registerTestLogIpc = (
  assertTrustedIpcSender: AssertTrustedIpcSender,
  options?: {
    publishDiagnosticRecord?: (payload: TestLogAppendPayload) => Promise<unknown>;
  }
) => {
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

    const record = sanitizeDiagnosticRecord(payload);

    if (!record) return { ok: false, error: "diagnostic-record-rejected" };

    const userDataPath = app.getPath("userData");
    await appendTestLogRecord(userDataPath, record);

    if (options?.publishDiagnosticRecord) {
      void options.publishDiagnosticRecord(record);
    }

    return { ok: true, path: getTestLogPath(userDataPath) };
  });
};
