// Data-residency model.
//
// A *zone* is a legal/geographic region whose users are served by a
// deployment in that region and whose data is stored only in that region.
// Cloudflare's edge Worker steers each visitor (by `request.cf.country`) to
// the regional Vultr Load Balancer for their zone; this module is the
// app-side counterpart that (a) describes the zone topology, (b) verifies the
// edge routed the request to the right zone, and (c) refuses to run if this
// instance's data store is not in the zone it claims to serve.
//
// The zone list is fully config-driven (WORKGRAPH_RESIDENCY_ZONES) so new
// regions are added without code changes.

export interface ResidencyZone {
  /** Stable id, e.g. "eu" — must match the Cloudflare Worker zone config. */
  id: string;
  /** Human label for the runtime panel, e.g. "EU · Frankfurt". */
  label: string;
  /** ISO 3166-1 alpha-2 countries routed to this zone (uppercase). */
  countries: string[];
  /** Exactly one zone is the fallback for unknown/unmapped countries. */
  default?: boolean;
}

export interface ResidencyStatus {
  /** Zone this instance serves. */
  activeZone: string;
  /** Zone its data store (Valkey) physically lives in. */
  dataZone: string;
  /** activeZone === dataZone — false means a residency violation. */
  consistent: boolean;
  /** When true, an inconsistency throws at startup instead of warning. */
  strict: boolean;
  zones: {
    id: string;
    label: string;
    countries: number;
    default: boolean;
  }[];
}

export interface RequestResidency {
  /** Country from Cloudflare (CF-IPCountry / X-WG-Country), uppercased. */
  country: string | null;
  /** Zone that *should* serve this country. */
  expectedZone: string;
  /** Zone actually serving the request (this instance). */
  servedZone: string;
  /** False = the edge sent this user to the wrong region. */
  routedCorrectly: boolean;
}

// Built-in topology used when WORKGRAPH_RESIDENCY_ZONES is unset, so the app
// is coherent out of the box and in tests. EU covers EU + EEA.
const DEFAULT_ZONES: ResidencyZone[] = [
  {
    id: "eu",
    label: "EU · Frankfurt",
    default: true,
    countries: [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
      "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
      "SI", "ES", "SE", "IS", "LI", "NO",
    ],
  },
  {
    id: "us",
    label: "US · New Jersey",
    countries: ["US", "PR", "GU", "VI", "AS", "MP"],
  },
];

function isZone(value: unknown): value is ResidencyZone {
  if (typeof value !== "object" || value === null) return false;
  const z = value as Record<string, unknown>;
  return (
    typeof z.id === "string" &&
    z.id.length > 0 &&
    typeof z.label === "string" &&
    Array.isArray(z.countries) &&
    z.countries.every((c) => typeof c === "string")
  );
}

/**
 * Parsed, validated zone list. Falls back to the built-in topology if the env
 * is missing or malformed (the app must never run with no residency model).
 * Guarantees exactly one default zone (first wins; if none flagged, the first
 * zone becomes default).
 */
export function getResidencyZones(): ResidencyZone[] {
  const raw = process.env.WORKGRAPH_RESIDENCY_ZONES?.trim();
  let zones: ResidencyZone[] = DEFAULT_ZONES;

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(isZone)
      ) {
        zones = (parsed as ResidencyZone[]).map((z) => ({
          ...z,
          countries: z.countries.map((c) => c.toUpperCase()),
        }));
      } else {
        console.warn(
          "[residency] WORKGRAPH_RESIDENCY_ZONES is not a non-empty zone array; using defaults",
        );
      }
    } catch {
      console.warn(
        "[residency] WORKGRAPH_RESIDENCY_ZONES is not valid JSON; using defaults",
      );
    }
  }

  let defaulted = false;
  const normalized = zones.map((z) => {
    const isDefault = !defaulted && z.default === true;
    if (isDefault) defaulted = true;
    return { ...z, default: isDefault };
  });
  if (!defaulted) normalized[0] = { ...normalized[0], default: true };
  return normalized;
}

function defaultZone(zones: ResidencyZone[]): ResidencyZone {
  return zones.find((z) => z.default) ?? zones[0];
}

/** Zone that should serve a given country; falls back to the default zone. */
export function zoneForCountry(
  country: string | null | undefined,
  zones: ResidencyZone[] = getResidencyZones(),
): ResidencyZone {
  const cc = country?.trim().toUpperCase();
  if (cc) {
    const hit = zones.find((z) => z.countries.includes(cc));
    if (hit) return hit;
  }
  return defaultZone(zones);
}

/** The zone id this instance serves (WORKGRAPH_ZONE, else the default zone). */
export function getActiveZoneId(zones: ResidencyZone[] = getResidencyZones()): string {
  const env = process.env.WORKGRAPH_ZONE?.trim();
  if (env && zones.some((z) => z.id === env)) return env;
  return defaultZone(zones).id;
}

/** Zone the data store lives in (WORKGRAPH_DATA_ZONE, else == active zone). */
export function getDataZoneId(zones: ResidencyZone[] = getResidencyZones()): string {
  const env = process.env.WORKGRAPH_DATA_ZONE?.trim();
  return env || getActiveZoneId(zones);
}

export function isStrictResidency(): boolean {
  return process.env.WORKGRAPH_RESIDENCY_STRICT === "true";
}

export function getResidencyStatus(): ResidencyStatus {
  const zones = getResidencyZones();
  const activeZone = getActiveZoneId(zones);
  const dataZone = getDataZoneId(zones);
  return {
    activeZone,
    dataZone,
    consistent: activeZone === dataZone,
    strict: isStrictResidency(),
    zones: zones.map((z) => ({
      id: z.id,
      label: z.label,
      countries: z.countries.length,
      default: z.default === true,
    })),
  };
}

/**
 * Defense in depth: even though Cloudflare steers by country, verify *here*
 * that the request landed on the zone that should serve its country. A
 * mismatch means an EU user's request reached a non-EU instance — surfaced so
 * it is visible and auditable rather than silently storing data cross-border.
 */
export function classifyRequest(
  country: string | null | undefined,
  zones: ResidencyZone[] = getResidencyZones(),
): RequestResidency {
  const cc = country?.trim().toUpperCase() || null;
  const expected = zoneForCountry(cc, zones).id;
  const served = getActiveZoneId(zones);
  return {
    country: cc,
    expectedZone: expected,
    servedZone: served,
    routedCorrectly: expected === served,
  };
}

/**
 * Hard residency guard. Called at process start (app + worker): if this
 * instance's data store is not in the zone it serves and strict mode is on,
 * refuse to run rather than store data in the wrong jurisdiction.
 */
export function assertResidency(): ResidencyStatus {
  const status = getResidencyStatus();
  if (!status.consistent) {
    const msg = `[residency] data store zone "${status.dataZone}" != served zone "${status.activeZone}" — cross-border storage risk`;
    if (status.strict) throw new Error(msg);
    console.warn(`${msg} (set WORKGRAPH_RESIDENCY_STRICT=true to enforce)`);
  }
  return status;
}
