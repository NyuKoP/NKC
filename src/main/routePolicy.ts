export type RouteMode = "auto" | "preferLokinet" | "preferTor" | "manual";

export type RouteTargets = {
  torOnion?: string;
  lokinet?: string;
};

export type RouteCandidate = {
  kind: "tor" | "lokinet";
  target: string;
};

export const DEFAULT_ROUTE_MODE: RouteMode = "auto";

const normalizeTarget = (value: string) =>
  value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;

export const buildRouteCandidates = (mode: RouteMode, targets: RouteTargets): RouteCandidate[] => {
  const tor = targets.torOnion ? { kind: "tor" as const, target: normalizeTarget(targets.torOnion) } : null;
  const lokinet = targets.lokinet ? { kind: "lokinet" as const, target: normalizeTarget(targets.lokinet) } : null;

  if (mode === "preferTor") return tor ? [tor] : [];
  if (mode === "preferLokinet") return lokinet ? [lokinet] : [];
  if (mode === "manual") return lokinet ? [lokinet] : tor ? [tor] : [];

  const candidates: RouteCandidate[] = [];
  if (lokinet) candidates.push(lokinet);
  if (tor) candidates.push(tor);
  return candidates;
};
