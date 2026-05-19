import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/valkey", () => ({ hasValkey: () => false }));

import { GET } from "@/app/api/deployment/route";

const ENV_KEYS = [
  "WORKGRAPH_ZONE",
  "WORKGRAPH_DATA_ZONE",
  "WORKGRAPH_RESIDENCY_ZONES",
  "WORKGRAPH_RESIDENCY_STRICT",
  "WORKGRAPH_RUNTIME",
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

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/deployment", { headers });
}

describe("GET /api/deployment", () => {
  it("includes the data-residency posture for this instance", async () => {
    process.env.WORKGRAPH_ZONE = "eu";
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.residency.activeZone).toBe("eu");
    expect(body.residency.dataZone).toBe("eu");
    expect(body.residency.consistent).toBe(true);
    expect(body.residency.zones.map((z: { id: string }) => z.id)).toEqual([
      "eu",
      "us",
    ]);
  });

  it("verifies the edge routed this request to the correct zone", async () => {
    process.env.WORKGRAPH_ZONE = "eu";
    const res = await GET(req({ "cf-ipcountry": "DE" }));
    const body = await res.json();
    expect(body.residency.requestCountry).toBe("DE");
    expect(body.residency.routedCorrectly).toBe(true);
  });

  it("flags a misrouted request (EU user reached the US instance)", async () => {
    process.env.WORKGRAPH_ZONE = "us";
    const res = await GET(req({ "x-wg-country": "FR" }));
    const body = await res.json();
    expect(body.residency.requestCountry).toBe("FR");
    expect(body.residency.routedCorrectly).toBe(false);
  });

  it("surfaces a residency violation when the data store is cross-zone", async () => {
    process.env.WORKGRAPH_ZONE = "eu";
    process.env.WORKGRAPH_DATA_ZONE = "us";
    const res = await GET(req());
    const body = await res.json();
    expect(body.residency.consistent).toBe(false);
  });
});
