import { describe, it, expect } from "vitest";
import { allFacts, retrieveRelevant } from "@/lib/memory";

describe("memory.allFacts", () => {
  it("returns the seeded graph and never exposes expired facts", () => {
    const facts = allFacts();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.status !== "expired")).toBe(true);
    expect(facts.map((f) => f.id)).toContain("legal-featurex");
  });

  it("returns the same set across calls when nothing was learned", () => {
    // The graph is now seed + facts learned this meeting; with an empty
    // learned cache (no Valkey/file in tests) it is the stable seed set.
    expect(allFacts().map((f) => f.id)).toEqual(allFacts().map((f) => f.id));
  });
});

describe("memory.retrieveRelevant", () => {
  it("ranks lexically matching facts first", () => {
    const hits = retrieveRelevant("Can we ship Feature X with the DPA still open?");
    expect(hits[0].id).toBe("legal-featurex");
  });

  it("matches on related entities and person names", () => {
    const hits = retrieveRelevant("Should we assign another P0 to Valya?");
    expect(hits.map((f) => f.id)).toContain("capacity-valya");
  });

  it("ignores tokens of 2 chars or fewer (no lexical hit -> active facts only)", () => {
    // "is"/"it"/"ok"/"ya" are all too short to match any entity term.
    const hits = retrieveRelevant("is it ok ya");
    const activeIds = allFacts()
      .filter((f) => f.status === "active")
      .map((f) => f.id)
      .sort();
    expect(hits.map((f) => f.id).sort()).toEqual(activeIds);
  });

  it("falls back to all active facts when nothing matches lexically", () => {
    const hits = retrieveRelevant("zzzzz qqqqq wwwww unrelated gibberish");
    const activeIds = allFacts()
      .filter((f) => f.status === "active")
      .map((f) => f.id)
      .sort();
    expect(hits.map((f) => f.id).sort()).toEqual(activeIds);
  });

  it("respects the result limit", () => {
    const hits = retrieveRelevant(
      "Acme launch Friday SSO Auth Refactor Feature X DPA Valya P0 export",
      2,
    );
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("boosts high-severity active blockers in the ranking", () => {
    // Both legal-featurex (high) and decision-acme-export (medium) can match
    // on "Acme"; the high-severity active blocker should outrank.
    const hits = retrieveRelevant("Acme");
    const legalIdx = hits.findIndex((f) => f.id === "legal-featurex");
    const decisionIdx = hits.findIndex((f) => f.id === "decision-acme-export");
    expect(legalIdx).toBeGreaterThanOrEqual(0);
    expect(legalIdx).toBeLessThan(decisionIdx);
  });
});
