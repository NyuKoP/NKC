type RecoveryDependencies = {
  processRunning: boolean;
  runtimeReady: boolean;
  routerConnected: boolean;
  start: () => Promise<void>;
  openRouter: () => Promise<unknown>;
  cancelled: () => boolean;
};

// A running Tor process does not imply that the renderer transport started.
export const restoreTorRouter = async (deps: RecoveryDependencies) => {
  if (deps.cancelled() || (deps.processRunning && deps.runtimeReady && deps.routerConnected)) return;
  await deps.start();

  if (!deps.cancelled()) await deps.openRouter();
};
