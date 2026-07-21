import { BRIDGE_FILE_CONTENTS } from "./circumventionBridges";

export type BridgeType =
  | "DEFAULT_OBFS4"
  | "NON_DEFAULT_OBFS4"
  | "VANILLA"
  | "MEEK"
  | "SNOWFLAKE";

type BridgeSelectionMode = "off" | "auto" | "force";

export type BridgeSelection = {
  enabled: boolean;
  mode: BridgeSelectionMode;
  countryCode: string;
  bridgeTypes: BridgeType[];
  lines: string[];
  requiresLyrebird: boolean;
  reason?: string;
};

const DEFAULT_COUNTRY_CODE = "ZZ";

const BRIDGE_TYPE_LETTER: Record<BridgeType, string> = {
  DEFAULT_OBFS4: "d",
  NON_DEFAULT_OBFS4: "n",
  VANILLA: "v",
  MEEK: "m",
  SNOWFLAKE: "s",
};

const COUNTRIES_DEFAULT_OBFS4 = new Set(["BY"]);
const COUNTRIES_NON_DEFAULT_OBFS4 = new Set(["BY", "CN", "EG", "HK", "IR", "MM", "RU", "TM"]);
const COUNTRIES_VANILLA = new Set(["BY"]);
const COUNTRIES_MEEK = new Set(["TM"]);
const COUNTRIES_SNOWFLAKE = new Set(["BY", "CN", "EG", "HK", "IR", "MM", "RU", "TM"]);

const dedupe = (values: string[]) => Array.from(new Set(values));

export const normalizeCountryCode = (value: string | null | undefined) => {
  if (!value) return DEFAULT_COUNTRY_CODE;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return DEFAULT_COUNTRY_CODE;
  return normalized;
};

export const shouldUseBridges = (countryCode: string) => {
  const cc = normalizeCountryCode(countryCode);
  return (
    COUNTRIES_DEFAULT_OBFS4.has(cc) ||
    COUNTRIES_NON_DEFAULT_OBFS4.has(cc) ||
    COUNTRIES_VANILLA.has(cc) ||
    COUNTRIES_MEEK.has(cc) ||
    COUNTRIES_SNOWFLAKE.has(cc)
  );
};

export const getSuitableBridgeTypes = (countryCode: string): BridgeType[] => {
  const cc = normalizeCountryCode(countryCode);
  const types: BridgeType[] = [];
  if (COUNTRIES_DEFAULT_OBFS4.has(cc)) types.push("DEFAULT_OBFS4");
  if (COUNTRIES_NON_DEFAULT_OBFS4.has(cc)) types.push("NON_DEFAULT_OBFS4");
  if (COUNTRIES_VANILLA.has(cc)) types.push("VANILLA");
  if (COUNTRIES_MEEK.has(cc)) types.push("MEEK");
  if (COUNTRIES_SNOWFLAKE.has(cc)) types.push("SNOWFLAKE");
  if (types.length === 0) {
    types.push("DEFAULT_OBFS4", "VANILLA");
  }
  return types;
};

const buildResourceName = (type: BridgeType, countryCode: string) => {
  const cc = normalizeCountryCode(countryCode).toLowerCase();
  return `bridges-${BRIDGE_TYPE_LETTER[type]}-${cc}`;
};

const getBridgeResourceLines = (type: BridgeType, countryCode: string) => {
  const preferred = BRIDGE_FILE_CONTENTS[buildResourceName(type, countryCode)];
  if (preferred?.length) return [...preferred];
  const fallback = BRIDGE_FILE_CONTENTS[buildResourceName(type, DEFAULT_COUNTRY_CODE)];
  return fallback ? [...fallback] : [];
};

export const getBridges = (type: BridgeType, countryCode: string) => {
  return getBridgeResourceLines(type, countryCode).map((line) => `Bridge ${line}`);
};

const stripBridgePrefix = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().startsWith("bridge ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
};

export const needsLyrebird = (line: string) => {
  const raw = stripBridgePrefix(line).toLowerCase();
  return raw.startsWith("obfs4 ") || raw.startsWith("meek_lite ") || raw.startsWith("snowflake ");
};

const parseMode = (mode: string | null | undefined): BridgeSelectionMode => {
  const normalized = (mode ?? "").trim().toLowerCase();
  if (normalized === "auto" || normalized === "force") return normalized;
  return "off";
};

export const resolveBridgeSelection = (options: {
  countryCode: string;
  mode?: string | null;
}): BridgeSelection => {
  const mode = parseMode(options.mode);
  const countryCode = normalizeCountryCode(options.countryCode);
  if (mode === "off") {
    return {
      enabled: false,
      mode,
      countryCode,
      bridgeTypes: [],
      lines: [],
      requiresLyrebird: false,
      reason: "mode-off",
    };
  }

  if (mode === "auto" && !shouldUseBridges(countryCode)) {
    return {
      enabled: false,
      mode,
      countryCode,
      bridgeTypes: [],
      lines: [],
      requiresLyrebird: false,
      reason: "country-not-recommended",
    };
  }

  const bridgeTypes = getSuitableBridgeTypes(countryCode);
  const lines = dedupe(
    bridgeTypes
      .map((type) => getBridges(type, countryCode))
      .flat()
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const requiresLyrebird = lines.some((line) => needsLyrebird(line));
  return {
    enabled: lines.length > 0,
    mode,
    countryCode,
    bridgeTypes,
    lines,
    requiresLyrebird,
    reason: lines.length > 0 ? undefined : "no-bridge-lines",
  };
};

