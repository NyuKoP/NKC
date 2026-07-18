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

export const normalizeRouteTarget = (kind: "tor" | "alternateRoute", value: string) => {
  try {
    const parsed = new URL(value.startsWith("http://") ? value : `http://${value}`);
    if (
      parsed.protocol !== "http:" ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (kind === "tor" && !/^[a-z2-7]{56}\.onion$/.test(hostname)) return null;
    if (
      kind === "alternateRoute" &&
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+loki$/.test(hostname)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

export const buildRouteCandidates = (
  mode: RouteMode,
  targets: RouteTargets,
  availability: RouteAvailability = {}
): RouteCandidate[] => {
  const torAvailable = availability.tor ?? true;
  const alternateRouteAvailable = availability.alternateRoute ?? true;
  const normalizedTor = targets.torOnion
    ? normalizeRouteTarget("tor", targets.torOnion)
    : null;
  const normalizedalternateRoute = targets.alternateRoute
    ? normalizeRouteTarget("alternateRoute", targets.alternateRoute)
    : null;
  const hasTor = Boolean(normalizedTor);
  const hasalternateRoute = Boolean(normalizedalternateRoute);
  const tor =
    hasTor && torAvailable
      ? { kind: "tor" as const, target: normalizedTor ?? "" }
      : null;
  const alternateRoute =
    hasalternateRoute && alternateRouteAvailable
      ? { kind: "alternateRoute" as const, target: normalizedalternateRoute ?? "" }
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
