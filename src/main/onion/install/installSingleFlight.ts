import type { OnionNetwork } from "../../../net/netConfig";

type Mutation = "install" | "update" | "uninstall";
const activeInstalls = new Map<OnionNetwork, { operation: Mutation; task: Promise<void> }>();

export const runInstallSingleFlight = (
  network: OnionNetwork,
  install: () => Promise<void>,
  operation: Mutation = "install"
) => {
  const active = activeInstalls.get(network);

  if (active) return active.operation === operation
    ? active.task
    : Promise.reject(new Error("ONION_MUTATION_IN_PROGRESS"));

  const task = Promise.resolve()
    .then(install)
    .finally(() => {
      if (activeInstalls.get(network)?.task === task) {
        activeInstalls.delete(network);
      }
    });

  activeInstalls.set(network, { operation, task });

  return task;
};

export const hasActiveInstall = (network: OnionNetwork) => activeInstalls.has(network);
