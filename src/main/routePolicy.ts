export type RouteMode = "auto" | "preferLokinet" | "preferTor" | "manual";

export type RouteTargets = {
  torOnion?: string;
  lokinet?: string;
};

export type RouteAvailability = {
  tor?: boolean;
  lokinet?: boolean;
};

export type RouteCandidate = {
  kind: "tor" | "lokinet";
  target: string;
};

export const DEFAULT_ROUTE_MODE: RouteMode = "auto";

export const normalizeRouteTarget = (kind: "tor" | "lokinet", value: string) => {
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
      kind === "lokinet" &&
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
  const lokinetAvailable = availability.lokinet ?? true;
  const normalizedTor = targets.torOnion
    ? normalizeRouteTarget("tor", targets.torOnion)
    : null;
  const normalizedLokinet = targets.lokinet
    ? normalizeRouteTarget("lokinet", targets.lokinet)
    : null;
  const hasTor = Boolean(normalizedTor);
  const hasLokinet = Boolean(normalizedLokinet);
  const tor =
    hasTor && torAvailable
      ? { kind: "tor" as const, target: normalizedTor ?? "" }
      : null;
  const lokinet =
    hasLokinet && lokinetAvailable
      ? { kind: "lokinet" as const, target: normalizedLokinet ?? "" }
      : null;

  if (mode === "preferTor") return tor ? [tor] : [];
  if (mode === "preferLokinet") return lokinet ? [lokinet] : [];
  if (mode === "manual") {
    if (hasTor && hasLokinet) return [];
    if (hasLokinet) return lokinet ? [lokinet] : [];
    if (hasTor) return tor ? [tor] : [];
    return [];
  }

  const candidates: RouteCandidate[] = [];
  if (lokinet) candidates.push(lokinet);
  if (tor) candidates.push(tor);
  return candidates;
};

export const selectRoute = (
  mode: RouteMode,
  targets: RouteTargets,
  availability?: RouteAvailability
) => buildRouteCandidates(mode, targets, availability);
