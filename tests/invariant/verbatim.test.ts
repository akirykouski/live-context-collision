import { describe, it, expect, vi, beforeEach } from "vitest";
import seed from "@/data/memory.json";
import type { MemoryFact } from "@/lib/types";

/**
 * INVARIANT: collision cards quote the RAW source, never enhanced/paraphrased
 * text. The Transcript Enhancer (Layers 1-3) is a non-destructive overlay;
 * downstream NLU may *read* resolutions but the card layer must still surface
 * verbatim evidence.
 *
 * We exercise the deterministic fallback collision path: mock the AI gateway
 * so every specialist call errors → analyzeUtterance falls back to
 * fallbackCollisionResult → cards are built from memory facts and run through
 * the evidence verifier. Then we assert every card's evidence quote string is
 * found verbatim (case-insensitive substring) in the backing memory fact's
 * statement / reason / rule (the raw seed text it came from).
 */

// Force the deterministic fallback path: every specialist "errors" (as it
// would when the Gemini gateway is fully down). We mock at the specialists
// boundary — keeping the real SPECIALISTS list — so analyzeUtterance sees
// `outputs.every(o => o.errored)` and runs fallbackCollisionResult, which is
// the exact path that proves "cards quote RAW memory, never enhanced text".
const { runSpecialist } = vi.hoisted(() => ({
  runSpecialist: vi.fn(async () => ({ cards: [], errored: true })),
}));
vi.mock("@/lib/collision/specialists", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/collision/specialists")>();
  return { ...actual, runSpecialist };
});

// Keep learned-facts inert so the graph is exactly the JSON seed.
vi.mock("@/lib/learned-facts", () => ({
  hydrateLearnedFacts: vi.fn(async () => {}),
  learnedFactsCache: () => [] as MemoryFact[],
}));

import { analyzeUtterance } from "@/lib/gemini";

const FACTS = (seed as { facts: MemoryFact[] }).facts;

function rawTextFor(fact: MemoryFact): string {
  return [
    fact.statement,
    fact.reason,
    fact.rule,
    ...(fact.activeP0s ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

beforeEach(() => runSpecialist.mockClear());

describe("INVARIANT: collision cards quote raw, never enhanced text", () => {
  const scenarios: { speaker: string; text: string }[] = [
    {
      speaker: "Sales",
      text: "Let's promise Acme we'll launch Feature X this Friday — the DPA is fine.",
    },
    {
      speaker: "EM",
      text: "We can ship SSO on Friday even though the Auth Refactor isn't done.",
    },
    {
      speaker: "PM",
      text: "Let's build the custom export for Acme after all.",
    },
    {
      speaker: "Lead",
      text: "Make Valya the owner — this is the new top priority P0.",
    },
  ];

  it("uses the deterministic fallback (every specialist errored)", async () => {
    const r = await analyzeUtterance(scenarios[0]);
    // Every specialist reported errored → deterministic fallback ran.
    expect(runSpecialist).toHaveBeenCalled();
    expect(r.collisionDetected).toBe(true);
    expect(r.cards.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    it(`every card quote is verbatim in its backing fact — "${scenario.text.slice(0, 40)}..."`, async () => {
      const result = await analyzeUtterance(scenario);
      expect(result.collisionDetected).toBe(true);
      expect(result.cards.length).toBeGreaterThan(0);

      for (const card of result.cards) {
        expect(card.evidence.length).toBeGreaterThan(0);
        for (const ev of card.evidence) {
          // The quote must be grounded in one of the card's cited facts'
          // raw seed text — verbatim, case-insensitive substring.
          const backing = FACTS.filter((f) => card.factIds.includes(f.id));
          expect(backing.length).toBeGreaterThan(0);
          const found = backing.some((f) =>
            rawTextFor(f).includes(ev.quote.toLowerCase().trim()),
          );
          expect(
            found,
            `card quote not verbatim in any cited raw fact: ${JSON.stringify(
              ev,
            )} (factIds=${card.factIds.join(",")})`,
          ).toBe(true);
        }
      }
    });
  }
});
