import { describe, it, expect, beforeEach, vi } from "vitest";

const { valkeyState } = vi.hoisted(() => ({
  valkeyState: {
    available: true,
    getCalls: [] as string[],
    // Set per-test: a value to return, an error to throw, or undefined for null.
    getResult: null as string | null,
    getThrows: null as Error | null,
  },
}));

vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => ({
    async get(k: string) {
      valkeyState.getCalls.push(k);
      if (valkeyState.getThrows) throw valkeyState.getThrows;
      return valkeyState.getResult;
    },
  }),
}));

import { hotFactsFor, prewarmHitStats } from "@/lib/collision/specialists";
import { prewarmKeys } from "@/lib/types";
import type { MemoryFact } from "@/lib/types";

const FACTS: MemoryFact[] = [
  {
    id: "commitment-acme",
    type: "commitment",
    entity: "Acme",
    status: "active",
    source: "Sales",
    statement: "Acme is a high-value customer.",
  },
];

beforeEach(() => {
  prewarmHitStats.hits = 0;
  prewarmHitStats.misses = 0;
  valkeyState.available = true;
  valkeyState.getCalls = [];
  valkeyState.getResult = null;
  valkeyState.getThrows = null;
});

describe("hotFactsFor (specialists prewarm seam)", () => {
  it("returns null and counts nothing when meetingId is undefined (pure no-op)", async () => {
    expect(await hotFactsFor(undefined)).toBeNull();
    expect(prewarmHitStats).toEqual({ hits: 0, misses: 0 });
    expect(valkeyState.getCalls).toEqual([]);
  });

  it("returns null when Valkey is unavailable (no-op)", async () => {
    valkeyState.available = false;
    expect(await hotFactsFor("m1")).toBeNull();
    expect(prewarmHitStats).toEqual({ hits: 0, misses: 0 });
  });

  it("hit: parses prewarmKeys.hot into MemoryFact[] and bumps hits", async () => {
    valkeyState.getResult = JSON.stringify(FACTS);
    const facts = await hotFactsFor("m1");
    expect(facts).toEqual(FACTS);
    expect(valkeyState.getCalls).toEqual([prewarmKeys.hot("m1")]);
    expect(prewarmHitStats).toEqual({ hits: 1, misses: 0 });
  });

  it("miss: key absent → null + misses++", async () => {
    valkeyState.getResult = null;
    expect(await hotFactsFor("m1")).toBeNull();
    expect(prewarmHitStats).toEqual({ hits: 0, misses: 1 });
  });

  it("never throws on malformed JSON → null + misses++", async () => {
    valkeyState.getResult = "{ not json";
    expect(await hotFactsFor("m1")).toBeNull();
    expect(prewarmHitStats).toEqual({ hits: 0, misses: 1 });
  });

  it("never throws when the store call rejects → null + misses++", async () => {
    valkeyState.getThrows = new Error("store down");
    expect(await hotFactsFor("m1")).toBeNull();
    expect(prewarmHitStats).toEqual({ hits: 0, misses: 1 });
  });
});
