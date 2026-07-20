import { ipcMain } from "electron";
import crypto from "node:crypto";
import path from "node:path";
import type { NativeWorkerClient } from "../nativeWorkerClient";
import type { AssertTrustedIpcSender, IsTrustedIpcSender } from "./types";

type RegisterNativeWorkerIpcOptions = {
  assertTrustedIpcSender: AssertTrustedIpcSender;
  isTrustedIpcSender: IsTrustedIpcSender;
  getNativeWorkerClient: () => NativeWorkerClient | null;
};

let preloadToken = crypto.randomUUID();
let isTokenConsumed = false;

export const resetPreloadToken = () => {
  preloadToken = crypto.randomUUID();
  isTokenConsumed = false;
};

export const registerNativeWorkerIpc = (options: RegisterNativeWorkerIpcOptions) => {
  ipcMain.on("security:get-preload-token", (event) => {
    if (!options.isTrustedIpcSender(event) || isTokenConsumed) {
      event.returnValue = null;
      return;
    }
    isTokenConsumed = true;
    event.returnValue = preloadToken;
  });

  ipcMain.handle(
    "nativeWorker:fileInspect",
    async (event, payload: { path?: string; chunkSize?: number; token?: string }) => {
      options.assertTrustedIpcSender(event);
      if (!payload?.token || payload.token !== preloadToken) {
        throw new Error("Unauthorized file access: Invalid or missing token");
      }
      const client = options.getNativeWorkerClient();
      if (!client) return { ok: false, error: "native-worker-unavailable" };
      if (!payload.path || !path.isAbsolute(payload.path) || !Number.isInteger(payload.chunkSize)) {
        return { ok: false, error: "invalid-file-request" };
      }
      const result = await client.request(
        "file.inspect",
        { path: payload.path, chunkSize: payload.chunkSize },
        120_000
      );
      return { ok: true, result };
    }
  );

  ipcMain.handle(
    "nativeWorker:fileChunk",
    async (
      event,
      payload: { path?: string; index?: number; chunkSize?: number; token?: string }
    ) => {
      options.assertTrustedIpcSender(event);
      if (!payload?.token || payload.token !== preloadToken) {
        throw new Error("Unauthorized file access: Invalid or missing token");
      }
      const client = options.getNativeWorkerClient();
      if (!client) return { ok: false, error: "native-worker-unavailable" };
      if (
        !payload.path ||
        !path.isAbsolute(payload.path) ||
        !Number.isInteger(payload.index) ||
        !Number.isInteger(payload.chunkSize)
      ) {
        return { ok: false, error: "invalid-file-request" };
      }
      const result = await client.request(
        "file.chunk",
        { path: payload.path, index: payload.index, chunkSize: payload.chunkSize },
        30_000
      );
      return { ok: true, result };
    }
  );

  ipcMain.handle("nativeWorker:schedule", async (event, payload: unknown) => {
    options.assertTrustedIpcSender(event);
    const client = options.getNativeWorkerClient();
    if (!client) return { ok: false, error: "native-worker-unavailable" };
    const result = await client.request("scheduler.plan", payload, 5_000);
    return { ok: true, result };
  });
};
