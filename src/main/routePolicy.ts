export type RouteMode = "auto" | "preferalternateRoute" | "preferTor" | "manual";

export type RouteTargets = {
  torOnion?: string;
  alternateRoute?: string;
};

export type RouteCandidate = {
  kind: "tor" | "alternateRoute";
  target: string;
};

export const DEFAULT_ROUTE_MODE: RouteMode = "auto";

const normalizeTarget = (value: string) =>
  value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;

export const buildRouteCandidates = (mode: RouteMode, targets: RouteTargets): RouteCandidate[] => {
  const tor = targets.torOnion ? { kind: "tor" as const, target: normalizeTarget(targets.torOnion) } : null;
  const alternateRoute = targets.alternateRoute ? { kind: "alternateRoute" as const, target: normalizeTarget(targets.alternateRoute) } : null;

  if (mode === "preferTor") return tor ? [tor] : [];
  if (mode === "preferalternateRoute") return alternateRoute ? [alternateRoute] : [];
  if (mode === "manual") return alternateRoute ? [alternateRoute] : tor ? [tor] : [];

  const candidates: RouteCandidate[] = [];
  if (alternateRoute) candidates.push(alternateRoute);
  if (tor) candidates.push(tor);
  return candidates;
};

export const selectRoute = (mode: RouteMode, targets: RouteTargets) =>
  buildRouteCandidates(mode, targets);
