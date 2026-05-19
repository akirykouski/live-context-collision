import { describe, it, expect } from "vitest";
import { verifyCard } from "@/lib/collision/verifier";
import type { CollisionCard, MemoryFact } from "@/lib/types";

const FACTS: MemoryFact[] = [
  {
    id: "legal-featurex",
    type: "legal_blocker",
    entity: "Feature X",
    status: "active",
    source: "Legal Review, May 12",
    statement: "Do not proceed with Feature X until the DPA update is approved.",
    reason: "Customer data retention risk.",
    severity: "high",
  },
  {
    id: "capacity-valya",
    type: "person_capacity",
    entity: "Valya",
    status: "active",
    source: "Priority board, current",
    statement: "Valya already owns 3 active P0 priorities.",
    severity: "high",
  },
];

function card(
  over: Partial<Omit<CollisionCard, "id" | "triggeredBy">> = {},
): Omit<CollisionCard, "id" | "triggeredBy"> {
  return {
    collisionType: "legal_compliance",
    title: "Context collision detected",
    headline: "Feature X cannot be promised yet.",
    evidence: [],
    severity: "high",
    factIds: [],
    ...over,
  };
}

describe("verifyCard", () => {
  it("passes a card with no evidence through unchanged", () => {
    const r = verifyCard(card(), FACTS);
    expect(r.card).not.toBeNull();
    expect(r.repaired).toBe(false);
  });

  it("rewrites a paraphrased quote to the fact's verbatim statement", () => {
    const r = verifyCard(
      card({
        factIds: ["legal-featurex"],
        evidence: [
          { source: "Legal", quote: "feature x blocked until DPA approved" },
        ],
      }),
      FACTS,
    );
    expect(r.card?.evidence).toEqual([
      {
        source: "Legal Review, May 12",
        quote:
          "Do not proceed with Feature X until the DPA update is approved.",
      },
    ]);
    expect(r.repaired).toBe(true);
  });

  it("drops a card whose every quote is fabricated", () => {
    const r = verifyCard(
      card({
        factIds: ["legal-featurex"],
        evidence: [
          { source: "Legal", quote: "the moon is made of cheese entirely" },
        ],
      }),
      FACTS,
    );
    expect(r.card).toBeNull();
    expect(r.reason).toBe("all evidence ungrounded");
  });

  it("recovers a real quote even when the cited factId is wrong", () => {
    const r = verifyCard(
      card({
        factIds: ["does-not-exist"],
        evidence: [
          { source: "?", quote: "Valya already owns 3 active P0 priorities" },
        ],
      }),
      FACTS,
    );
    expect(r.card?.evidence[0].source).toBe("Priority board, current");
    expect(r.card?.factIds).toContain("capacity-valya");
  });
});
