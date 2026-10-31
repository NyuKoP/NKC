import { dialog, ipcMain, safeStorage } from "electron";
import type { MainAccountSession } from "../../accounts/mainSessionTypes";
import type { PermanentMediaRequest } from "../../media/permanentMediaTypes";
import type { AccountSessionAuthority } from "../accountSessionAuthority";
import { createPermanentMediaFiles } from "../services/permanentMediaFiles";
import type { AssertTrustedIpcSender } from "./types";

export const registerPermanentMediaIpc = (trusted: AssertTrustedIpcSender, sessions: AccountSessionAuthority) => {
  const files = createPermanentMediaFiles({
    chooseDestination: async name => {
      const result = await dialog.showSaveDialog({ title: "Decrypt permanently", defaultPath: name,
        buttonLabel: "Decrypt permanently", properties: ["showOverwriteConfirmation", "dontAddToRecent"] });

      return result.canceled ? undefined : result.filePath;
    },
    protect: value => {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
        throw new Error("SECURE_STORAGE_UNAVAILABLE");
      }

      return safeStorage.encryptString(value).toString("base64");
    },
    unprotect: value => safeStorage.decryptString(Buffer.from(value, "base64")),
  });

  ipcMain.handle("nkc:permanentMedia", async (event, session: MainAccountSession, request: PermanentMediaRequest) => {
    trusted(event);
    const owner = sessions.assertCurrent(event.sender.id, session);
    const assertOwner = () => { sessions.assertCurrent(event.sender.id, session); };

    const result = await files(owner.accountId, request, assertOwner);
    assertOwner();

    return result;
  });
};
