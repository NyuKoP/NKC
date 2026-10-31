import { ipcMain } from "electron";
import type { IsTrustedIpcSender } from "./types";

type Capabilities = { unifiedText: boolean; recoveryV2: boolean; nativeRatchetCas: boolean; freshnessWitness?: boolean };

export const registerCapabilityIpc = (isTrusted: IsTrustedIpcSender, capabilities: Capabilities) => {
  ipcMain.on("phase2i:capability", event => {
    // A preload can run before navigation commits; deny without throwing out of synchronous IPC.
    let response = { unifiedText: false, recoveryV2: false, nativeRatchetCas: false };

    try {
      if (isTrusted(event)) response = capabilities;
    } catch {
      // Keep the denied response for transitional or destroyed senders.
    }
    // Electron sends the synchronous reply on assignment; a second write cannot replace it.
    event.returnValue = response;
  });
};
