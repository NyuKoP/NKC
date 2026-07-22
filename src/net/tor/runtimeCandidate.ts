export type TorRuntimeCandidate = {
  state: string | null;
  detail: string | null;
  socksUrl: string | null;
};

export const selectTorRuntimeCandidate = (
  componentRuntime: TorRuntimeCandidate | null,
  routingRuntime: TorRuntimeCandidate | null
) => componentRuntime ?? routingRuntime;
