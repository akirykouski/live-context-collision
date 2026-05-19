import seed from "@/data/memory.json";
import type { MemoryFact } from "./types";
import { learnedFactsCache } from "./learned-facts";

/**
 * The company memory graph. Seeded from JSON, plus facts the Memory Curator
 * wrote back from the live meeting (decisions/commitments made in *this* call).
 * Learned facts come from an in-process cache that {@link learnedFactsCache}
 * keeps warm, so retrieval stays synchronous on the hot path.
 */
const seedFacts: MemoryFact[] = (seed.facts as MemoryFact[]).filter(
  (f) => f.status !== "expired",
);

/** Seed graph + anything learned this meeting, expired facts excluded. */
function pool(): MemoryFact[] {
  const learned = learnedFactsCache().filter((f) => f.status !== "expired");
  return learned.length > 0 ? [...seedFacts, ...learned] : seedFacts;
}

export function allFacts(): MemoryFact[] {
  return pool();
}

/**
 * Cheap lexical pre-filter so we don't ship the entire graph to the model on
 * every utterance. The LLM still does the real relevance + collision judgement;
 * this just keeps the prompt tight and the demo fast.
 */
export function retrieveRelevant(text: string, limit = 8): MemoryFact[] {
  const haystack = text.toLowerCase();
  const tokens = haystack.split(/[^a-z0-9]+/).filter((t) => t.length > 2);

  const facts = pool();
  const scored = facts.map((fact) => {
    const terms = [
      fact.entity,
      ...(fact.related ?? []),
      ...(fact.activeP0s ?? []),
      fact.type.replace(/_/g, " "),
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (terms.includes(token)) score += 2;
    }
    // Boost high-severity active blockers — they matter most live.
    if (fact.status === "active") score += 0.5;
    if (fact.severity === "high") score += 0.5;
    return { fact, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fact);

  // If nothing matched lexically, fall back to all active facts so the model
  // still gets a chance to catch a semantic collision.
  return hits.length > 0 ? hits : facts.filter((f) => f.status === "active");
}
