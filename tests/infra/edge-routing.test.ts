import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { selectZone } from "../../deploy/cloudflare/worker.mjs";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const ZONES = [
  { id: "eu", origin: "eu-lb.example", default: true, countries: ["DE", "FR"] },
  { id: "us", origin: "us-lb.example", countries: ["US"] },
];

describe("Cloudflare Worker selectZone", () => {
  it("routes a country to its zone", () => {
    expect(selectZone("DE", ZONES).id).toBe("eu");
    expect(selectZone("US", ZONES).id).toBe("us");
  });

  it("is case-insensitive", () => {
    expect(selectZone("us", ZONES).id).toBe("us");
  });

  it("falls back to the default zone for unknown/empty country", () => {
    expect(selectZone("ZZ", ZONES).id).toBe("eu");
    expect(selectZone(null, ZONES).id).toBe("eu");
    expect(selectZone(undefined, ZONES).id).toBe("eu");
  });

  it("falls back to the first zone when none is flagged default", () => {
    const z = [
      { id: "a", origin: "a", countries: ["GB"] },
      { id: "b", origin: "b", countries: ["US"] },
    ];
    expect(selectZone("ZZ", z).id).toBe("a");
  });

  it("throws when zones are not configured", () => {
    expect(() => selectZone("DE", [])).toThrow(/not configured/);
  });
});

describe("edge-routing infra contract", () => {
  it("the Worker geo-routes by Cloudflare country and proxies to the zone origin", () => {
    const w = read("deploy/cloudflare/worker.mjs");
    expect(w).toMatch(/request\.cf\s*&&\s*request\.cf\.country/);
    expect(w).toContain('request.headers.get("CF-IPCountry")');
    expect(w).toContain("url.hostname = zone.origin");
    // forwards residency context for app-side verification
    expect(w).toContain('"X-WG-Residency-Zone"');
    expect(w).toContain('"X-WG-Served-Zone"');
  });

  it("ships a wrangler config with a zone topology", () => {
    const t = read("deploy/cloudflare/wrangler.toml");
    expect(t).toContain("main = \"worker.mjs\"");
    expect(t).toContain("RESIDENCY_ZONES");
    expect(t).toMatch(/"id":\s*"eu"/);
  });

  it("the Vultr compose has no self-hosted nginx LB (managed Vultr LB replaces it)", () => {
    const c = read("docker-compose.vultr.yml");
    expect(c).not.toMatch(/\bnginx\b/);
    expect(c).not.toMatch(/^\s{2}lb:/m);
    // per-region stack is just app + worker, zone-aware
    expect(c).toContain("WORKGRAPH_ZONE");
    expect(c).toContain("WORKGRAPH_DATA_ZONE");
    expect(c).toContain("WORKGRAPH_RESIDENCY_STRICT");
  });

  it("removed the superseded self-hosted nginx config", () => {
    expect(() => read("deploy/nginx/nginx.conf")).toThrow();
  });
});
