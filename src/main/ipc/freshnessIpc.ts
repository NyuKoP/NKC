import { ipcMain } from "electron";
import type { AccountSessionAuthority } from "../accountSessionAuthority";
import type { MainAccountSession } from "../../accounts/mainSessionTypes";
import type { AssertTrustedIpcSender } from "./types";
import type { FreshnessAuthority, LocalAuthorityHead } from "../freshness/freshnessAuthority";
import type { SignedTransition } from "../freshness/witnessProtocol";

export const registerFreshnessIpc = (trusted: AssertTrustedIpcSender, sessions: AccountSessionAuthority,
  getAuthority: () => FreshnessAuthority) => {
  ipcMain.handle("freshness:verify", async (event, session: MainAccountSession, head: LocalAuthorityHead, record?: SignedTransition) => {
    trusted(event);
    const assertOwner = () => { sessions.assertCurrent(event.sender.id, session); };
    assertOwner();
    const result = await getAuthority().verify(session.token, head, assertOwner, record);
    assertOwner();

    return result;
  });
};
