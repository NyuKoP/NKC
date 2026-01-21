import { getDeviceRole } from "./deviceRole";

export const isPrimary = () => getDeviceRole() === "primary";

export const assertPrimary = (actionName: string) => {
  if (isPrimary()) return;
  const error = new Error(`Primary device required for ${actionName}`);
  (error as { code?: string; action?: string }).code = "PRIMARY_ONLY";
  (error as { code?: string; action?: string }).action = actionName;
  throw error;
};
