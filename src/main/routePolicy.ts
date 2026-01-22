export type RouteMode = "auto" | "preferalternateRoute" | "preferTor" | "manual";

export type RouteTargets = {
  torOnion?: string;
  alternateRoute?: string;
};

export type RouteAvailability = {
  tor?: boolean;
  alternateRoute?: boolean;
};

export type RouteCandidate = {
  kind: "tor" | "alternateRoute";
  target: string;
};

export const DEFAULT_ROUTE_MODE: RouteMode = "auto";

const normalizeTarget = (value: string) =>
  value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;

export const buildRouteCandidates = (
  mode: RouteMode,
  targets: RouteTargets,
  availability: RouteAvailability = {}
): RouteCandidate[] => {
  const torAvailable = availability.tor ?? true;
  const alternateRouteAvailable = availability.alternateRoute ?? true;
  const hasTor = Boolean(targets.torOnion);
  const hasalternateRoute = Boolean(targets.alternateRoute);
  const tor =
    hasTor && torAvailable
      ? { kind: "tor" as const, target: normalizeTarget(targets.torOnion ?? "") }
      : null;
  const alternateRoute =
    hasalternateRoute && alternateRouteAvailable
      ? { kind: "alternateRoute" as const, target: normalizeTarget(targets.alternateRoute ?? "") }
      : null;

  if (mode === "preferTor") return tor ? [tor] : [];
  if (mode === "preferalternateRoute") return alternateRoute ? [alternateRoute] : [];
  if (mode === "manual") {
    if (hasTor && hasalternateRoute) return [];
    if (hasalternateRoute) return alternateRoute ? [alternateRoute] : [];
    if (hasTor) return tor ? [tor] : [];
    return [];
  }

  const candidates: RouteCandidate[] = [];
  if (alternateRoute) candidates.push(alternateRoute);
  if (tor) candidates.push(tor);
  return candidates;
};

export const selectRoute = (
  mode: RouteMode,
  targets: RouteTargets,
  availability?: RouteAvailability
) => buildRouteCandidates(mode, targets, availability);
