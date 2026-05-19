// WorkGraph AI — Cloudflare edge geo-router for data residency.
//
// Cloudflare resolves the visitor's country (`request.cf.country`) at the
// edge. This Worker maps that country to a residency *zone*, then proxies the
// request to that zone's regional Vultr Load Balancer origin. A user's traffic
// (and therefore their data) never leaves their zone.
//
// Zone config is provided as the `RESIDENCY_ZONES` Worker variable (JSON,
// wrangler.toml / dashboard). Shape matches src/lib/residency.ts plus an
// `origin` per zone (the regional Vultr LB hostname). Keep ids in sync with
// the app's WORKGRAPH_RESIDENCY_ZONES.

/**
 * Pure routing core — no Cloudflare globals, unit-tested under Node.
 * Returns the zone that should serve `country`, falling back to the zone
 * flagged `default` (or the first zone).
 *
 * @param {string|null|undefined} country ISO 3166-1 alpha-2
 * @param {Array<{id:string,origin:string,countries:string[],default?:boolean}>} zones
 */
export function selectZone(country, zones) {
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error("residency zones are not configured");
  }
  const fallback = zones.find((z) => z.default === true) ?? zones[0];
  const cc = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (cc) {
    const hit = zones.find(
      (z) => Array.isArray(z.countries) && z.countries.includes(cc),
    );
    if (hit) return hit;
  }
  return fallback;
}

function parseZones(env) {
  const raw = (env && env.RESIDENCY_ZONES) || "";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("RESIDENCY_ZONES must be a non-empty JSON array");
  }
  return parsed;
}

export default {
  async fetch(request, env) {
    let zones;
    try {
      zones = parseZones(env);
    } catch (err) {
      return new Response(`residency misconfigured: ${err.message}`, {
        status: 500,
      });
    }

    const country =
      (request.cf && request.cf.country) ||
      request.headers.get("CF-IPCountry") ||
      null;
    const zone = selectZone(country, zones);

    const url = new URL(request.url);
    url.hostname = zone.origin;
    url.protocol = "https:";
    url.port = "";

    // Forward residency context so the origin app can verify the edge routed
    // correctly (defense in depth) instead of blindly trusting DNS.
    const headers = new Headers(request.headers);
    headers.set("X-WG-Country", country || "");
    headers.set("X-WG-Residency-Zone", zone.id);
    headers.set("X-Forwarded-Host", url.host);

    const upstream = await fetch(
      new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }),
    );

    const out = new Response(upstream.body, upstream);
    out.headers.set("X-WG-Served-Zone", zone.id);
    out.headers.set("X-WG-Country", country || "unknown");
    return out;
  },
};
