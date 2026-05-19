import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getResidencyZones,
  zoneForCountry,
  getActiveZoneId,
  getDataZoneId,
  getResidencyStatus,
  classifyRequest,
  assertResidency,
} from "@/lib/residency";

const ENV_KEYS = [
  "WORKGRAPH_RESIDENCY_ZONES",
  "WORKGRAPH_ZONE",
  "WORKGRAPH_DATA_ZONE",
  "WORKGRAPH_RESIDENCY_STRICT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getResidencyZones", () => {
  it("falls back to the built-in EU/US topology when env is unset", () => {
    const zones = getResidencyZones();
    expect(zones.map((z) => z.id)).toEqual(["eu", "us"]);
    expect(zones.find((z) => z.id === "eu")?.default).toBe(true);
    expect(zones.find((z) => z.id === "us")?.default).toBe(false);
  });

  it("parses a valid configured zone list and uppercases countries", () => {
    process.env.WORKGRAPH_RESIDENCY_ZONES = JSON.stringify([
      { id: "apac", label: "APAC", countries: ["sg", "jp"], default: true },
      { id: "eu", label: "EU", countries: ["de"] },
    ]);
    const zones = getResidencyZones();
    expect(zones.map((z) => z.id)).toEqual(["apac", "eu"]);
    expect(zones[0].countries).toEqual(["SG", "JP"]);
    expect(zones[0].default).toBe(true);
  });

  it("forces exactly one default (first wins; first zone if none flagged)", () => {
    process.env.WORKGRAPH_RESIDENCY_ZONES = JSON.stringify([
      { id: "a", label: "A", countries: ["FR"], default: true },
      { id: "b", label: "B", countries: ["US"], default: true },
    ]);
    let zones = getResidencyZones();
    expect(zones.filter((z) => z.default)).toHaveLength(1);
    expect(zones.find((z) => z.default)?.id).toBe("a");

    process.env.WORKGRAPH_RESIDENCY_ZONES = JSON.stringify([
      { id: "a", label: "A", countries: ["FR"] },
      { id: "b", label: "B", countries: ["US"] },
    ]);
    zones = getResidencyZones();
    expect(zones.find((z) => z.default)?.id).toBe("a");
  });

  it("ignores malformed JSON and falls back to defaults with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKGRAPH_RESIDENCY_ZONES = "{not json";
    expect(getResidencyZones().map((z) => z.id)).toEqual(["eu", "us"]);
    expect(warn).toHaveBeenCalled();
  });

  it("ignores a structurally invalid array and falls back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKGRAPH_RESIDENCY_ZONES = JSON.stringify([
      { id: "x" /* no label/countries */ },
    ]);
    expect(getResidencyZones().map((z) => z.id)).toEqual(["eu", "us"]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("zoneForCountry", () => {
  it("maps an EU country to the eu zone", () => {
    expect(zoneForCountry("DE").id).toBe("eu");
    expect(zoneForCountry("fr").id).toBe("eu"); // case-insensitive
  });

  it("maps a US country to the us zone", () => {
    expect(zoneForCountry("US").id).toBe("us");
  });

  it("falls back to the default zone for unknown/empty country", () => {
    expect(zoneForCountry("ZZ").id).toBe("eu");
    expect(zoneForCountry(null).id).toBe("eu");
    expect(zoneForCountry(undefined).id).toBe("eu");
  });
});

describe("active / data zone resolution", () => {
  it("uses WORKGRAPH_ZONE when it names a real zone", () => {
    process.env.WORKGRAPH_ZONE = "us";
    expect(getActiveZoneId()).toBe("us");
  });

  it("ignores an unknown WORKGRAPH_ZONE and uses the default zone", () => {
    process.env.WORKGRAPH_ZONE = "atlantis";
    expect(getActiveZoneId()).toBe("eu");
  });

  it("data zone mirrors the active zone unless explicitly overridden", () => {
    process.env.WORKGRAPH_ZONE = "us";
    expect(getDataZoneId()).toBe("us");
    process.env.WORKGRAPH_DATA_ZONE = "eu";
    expect(getDataZoneId()).toBe("eu");
  });
});

describe("getResidencyStatus", () => {
  it("reports consistent when served zone == data zone", () => {
    process.env.WORKGRAPH_ZONE = "us";
    const s = getResidencyStatus();
    expect(s.activeZone).toBe("us");
    expect(s.dataZone).toBe("us");
    expect(s.consistent).toBe(true);
    expect(s.zones.find((z) => z.id === "eu")?.countries).toBeGreaterThan(0);
  });

  it("reports an inconsistency when the data store is in another zone", () => {
    process.env.WORKGRAPH_ZONE = "eu";
    process.env.WORKGRAPH_DATA_ZONE = "us";
    const s = getResidencyStatus();
    expect(s.consistent).toBe(false);
  });
});

describe("classifyRequest (edge-routing verification)", () => {
  it("flags a request that reached the correct zone", () => {
    process.env.WORKGRAPH_ZONE = "eu";
    const r = classifyRequest("DE");
    expect(r).toMatchObject({
      country: "DE",
      expectedZone: "eu",
      servedZone: "eu",
      routedCorrectly: true,
    });
  });

  it("flags an EU user that was misrouted to the US instance", () => {
    process.env.WORKGRAPH_ZONE = "us";
    const r = classifyRequest("FR");
    expect(r.expectedZone).toBe("eu");
    expect(r.servedZone).toBe("us");
    expect(r.routedCorrectly).toBe(false);
  });

  it("treats an unknown country as the default zone", () => {
    process.env.WORKGRAPH_ZONE = "eu";
    expect(classifyRequest(null).routedCorrectly).toBe(true);
  });
});

describe("assertResidency", () => {
  it("returns status and warns (does not throw) when not strict", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKGRAPH_ZONE = "eu";
    process.env.WORKGRAPH_DATA_ZONE = "us";
    const s = assertResidency();
    expect(s.consistent).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("throws on a residency violation when strict", () => {
    process.env.WORKGRAPH_ZONE = "eu";
    process.env.WORKGRAPH_DATA_ZONE = "us";
    process.env.WORKGRAPH_RESIDENCY_STRICT = "true";
    expect(() => assertResidency()).toThrow(/cross-border storage risk/);
  });

  it("is a no-op when consistent", () => {
    process.env.WORKGRAPH_ZONE = "eu";
    process.env.WORKGRAPH_RESIDENCY_STRICT = "true";
    expect(() => assertResidency()).not.toThrow();
  });
});
