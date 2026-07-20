export type RouteMode = "auto" | "preferTor" | "manual";

export type RouteTargets = {
  torOnion?: string;
};

export type RouteAvailability = {
  tor?: boolean;
};

export type SelectedRoute = {
  kind: "tor";
  target: string;
};

export const normalizeRouteTarget = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z2-7]{56}\.onion$/.test(trimmed)) return null;
  return trimmed;
};

export const selectRoute = (
  _mode: RouteMode,
  targets: RouteTargets,
  availability: RouteAvailability = {}
): SelectedRoute[] => {
  if (availability.tor === false || !targets.torOnion) return [];
  const target = normalizeRouteTarget(targets.torOnion);
  return target ? [{ kind: "tor", target }] : [];
};
