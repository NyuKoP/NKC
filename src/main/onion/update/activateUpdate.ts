import { compareVersions } from "./checkUpdates";

type InstalledUpdate = { version: string; installPath: string; rollback: () => Promise<void> };

// Restore the old runtime after either installation or new-runtime startup fails.
export const activateUpdate = async (operations: {
  currentVersion: string;
  nextVersion: string;
  stop: () => Promise<void>;
  install: () => Promise<InstalledUpdate>;
  start: () => Promise<unknown>;
  invalidatePath: () => void;
  restart: boolean;
}) => {
  if (compareVersions(operations.nextVersion, operations.currentVersion) <= 0) {
    throw new Error("No newer verified release available");
  }
  await operations.stop();
  let installed: InstalledUpdate | undefined;
  try {
    installed = await operations.install();
    operations.invalidatePath();
    if (operations.restart) await operations.start();
    return installed;
  } catch (error) {
    try {
      if (installed) {
        await operations.stop();
        await installed.rollback();
      }
      operations.invalidatePath();
      if (operations.restart) await operations.start();
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Tor update and recovery failed");
    }
    throw error;
  }
};
