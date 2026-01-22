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

const normalizeTarget = (value: string) =>
  value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`;

export const buildRouteCandidates = (
  mode: RouteMode,
  targets: RouteTargets,
  availability: RouteAvailability = {}
): RouteCandidate[] => {
  const torAvailable = availability.tor ?? true;
  const lokinetAvailable = availability.lokinet ?? true;
  const hasTor = Boolean(targets.torOnion);
  const hasLokinet = Boolean(targets.lokinet);
  const tor =
    hasTor && torAvailable
      ? { kind: "tor" as const, target: normalizeTarget(targets.torOnion ?? "") }
      : null;
  const lokinet =
    hasLokinet && lokinetAvailable
      ? { kind: "lokinet" as const, target: normalizeTarget(targets.lokinet ?? "") }
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
