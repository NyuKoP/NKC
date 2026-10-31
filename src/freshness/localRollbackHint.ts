import type { ReceiveContext } from "../accounts/receiveContext";
import type { DeviceAuthorization } from "../devices/deviceApprovals";
import type { RollbackHintState } from "../main/freshness/rollbackHint";

export const compareLocalRollbackHint = async (root: string, certificates: DeviceAuthorization[], context: ReceiveContext): Promise<RollbackHintState> => {
  await context.vault.assertMain();
  const compare = typeof window === "undefined" ? undefined : window.nkc?.compareRollbackHint;
  if (!compare) return "UNAVAILABLE";
  const state = await compare(context.owner.session, root, certificates);
  await context.vault.assertMain();
  return state;
};
export const assertNoLocalRollback = async (root: string, certificates: DeviceAuthorization[], context: ReceiveContext) => {
  const state = await compareLocalRollbackHint(root, certificates, context);
  if (state === "ROLLBACK_SUSPECTED" || state === "SECURITY_STATE_CONFLICT") throw new Error(state);
};
