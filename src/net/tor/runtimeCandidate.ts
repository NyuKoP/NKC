export type TorRuntimeCandidate = {
  state: string | null;
  detail: string | null;
  socksUrl: string | null;
};

export const selectTorRuntimeCandidate = (
  componentRuntime: TorRuntimeCandidate | null,
  routingRuntime: TorRuntimeCandidate | null
) => {
  if (componentRuntime?.state === "running") return componentRuntime;

  if (routingRuntime?.state === "running") return routingRuntime;

  return componentRuntime ?? routingRuntime;
};
