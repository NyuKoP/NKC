import type { MainAccountSession } from "./mainSessionTypes";
import { captureVaultAccess, type VaultAccess } from "../db/vaultAccess";
import type { ReceiveCompletion } from "../sync/receiveCompletion";
import { acquireMainAccountSession } from "./accountOwnerLifecycle";
import { getActiveAccountId } from "./accountRegistry";
import { createId } from "../utils/ids";

/** Main attaches this only to a validated local Controller read, never decoded packet fields. */
export type LocalReceiveOwner = Readonly<{
  accountId: string;
  session: MainAccountSession;
  mailboxDeviceId: string;
  operationId: string;
  expiresAt: number;
}>;

export type ReceiveContext = Readonly<{
  owner: LocalReceiveOwner;
  vault: VaultAccess;
}>;

/** Capture a local writer before its first await. This is not inbox admission/custody evidence. */
export const captureLocalOperationContext = async (): Promise<ReceiveContext | undefined> => {
  if (typeof window === "undefined" || !window.nkc?.activateAccountSession) return undefined;
  const accountId = getActiveAccountId();
  const session = await acquireMainAccountSession(accountId);
  const validate = window.nkc.validateAccountSession;

  if (!validate) throw new Error("OWNER_REQUIRED");

  const vault = captureVaultAccess(session, async handle => {
    if (!await validate(handle)) throw new Error("OWNER_SESSION_CHANGED");
  });

  await vault.assertMain();

  return Object.freeze({ vault, owner: Object.freeze({ accountId: session.accountId,
    session: Object.freeze({ ...session }), mailboxDeviceId: "", operationId: createId(), expiresAt: 0 }) });
};

export const openReceiveContext = async (localOwner?: LocalReceiveOwner): Promise<ReceiveContext | ReceiveCompletion> => {
  const validate = typeof window === "undefined" ? undefined : window.nkc?.validateAccountSession;

  if (!localOwner || !validate) {
    return { status: "FAILED", code: "OWNER_REQUIRED" };
  }

  const owner = Object.freeze({ ...localOwner, session: Object.freeze({ ...localOwner.session }) });

  try {
    if (!await validate(owner.session)) throw new Error("OWNER_SESSION_CHANGED");

    // The current session can inspect custody, but cannot decrypt another owner's vault.
    if (owner.session.accountId !== owner.accountId) throw new Error("RECIPIENT_VAULT_UNAVAILABLE");

    const vault = captureVaultAccess(owner.session, async session => {
      if (!await validate(session)) throw new Error("OWNER_SESSION_CHANGED");
    });

    await vault.assertMain();

    return Object.freeze({ owner, vault });
  } catch (error) {
    if (error instanceof Error && error.message === "RECIPIENT_VAULT_UNAVAILABLE" && owner.expiresAt > Date.now()) {
      try {
        if (await window.nkc?.verifyOnionInboxRetention?.(owner.session, owner.mailboxDeviceId, owner.operationId, owner.accountId) && owner.expiresAt > Date.now()) {
          return { status: "OWNED_DEFERRED", accountId: owner.accountId, eventId: owner.operationId,
            recoveryOwner: { mechanism: "existing-inbox", reference: `${owner.mailboxDeviceId}:${owner.operationId}` } };
        }
      } catch { /* Revoked or no longer retained: never certify recovery ownership. */ }

      return { status: "FAILED", code: "RECIPIENT_RECOVERY_UNAVAILABLE" };
    }

    return { status: "FAILED", code: "OWNER_SESSION_CHANGED" };
  }
};
