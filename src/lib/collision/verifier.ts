import type { CollisionCard, MemoryFact } from "../types";

/**
 * Deterministic anti-hallucination guard (no LLM, zero added latency).
 *
 * A collision card is only trustworthy if every evidence quote it shows is
 * actually present in one of the memory facts it cites. The judge reads this
 * in 3 seconds and acts on it — a fabricated quote is fatal. So before a card
 * reaches the screen we check each quote against the cited facts:
 *   - grounded quote  -> rewritten to the fact's verbatim statement + source
 *   - ungrounded quote -> dropped
 *   - every quote ungrounded (and there were quotes) -> the whole card is dropped
 */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 2);
}

/** Fraction of the quote's content tokens that appear in the fact text. */
function coverage(quote: string, factText: string): number {
  const q = tokens(quote);
  if (q.length === 0) return 0;
  const f = new Set(tokens(factText));
  let hit = 0;
  for (const t of q) if (f.has(t)) hit += 1;
  return hit / q.length;
}

function factText(f: MemoryFact): string {
  return [f.statement, f.reason, f.rule, ...(f.activeP0s ?? [])]
    .filter(Boolean)
    .join(" ");
}

/** A quote this much covered by a fact is considered grounded in it. */
const GROUNDED_THRESHOLD = 0.6;

export interface VerifyResult {
  /** The cleaned card, or null if it could not be grounded at all. */
  card: Omit<CollisionCard, "id" | "triggeredBy"> | null;
  /** True if any quote was rewritten or dropped. */
  repaired: boolean;
  reason?: string;
}

export function verifyCard(
  card: Omit<CollisionCard, "id" | "triggeredBy">,
  facts: MemoryFact[],
): VerifyResult {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const cited = card.factIds
    .map((id) => byId.get(id))
    .filter((f): f is MemoryFact => Boolean(f));

  const evidence = card.evidence ?? [];
  if (evidence.length === 0) {
    // Nothing quoted — weak, but there is no fabricated quote to catch.
    // Keep it; the model still flagged a real collision type.
    return { card: { ...card }, repaired: false };
  }

  // Prefer the facts the model cited; fall back to the whole retrieved set so
  // a correct quote with a wrong factId still survives.
  const pool = cited.length > 0 ? cited : facts;

  let repaired = false;
  const seen = new Set<string>();
  const grounded: { source: string; quote: string }[] = [];

  for (const ev of evidence) {
    let best: { fact: MemoryFact; cov: number } | null = null;
    for (const f of pool) {
      const cov = coverage(ev.quote, factText(f));
      if (!best || cov > best.cov) best = { fact: f, cov };
    }
    if (best && best.cov >= GROUNDED_THRESHOLD) {
      // Replace with the fact's canonical text so the card never shows a
      // paraphrase the source did not actually say.
      const key = `${best.fact.source}::${best.fact.statement}`;
      if (!seen.has(key)) {
        seen.add(key);
        grounded.push({ source: best.fact.source, quote: best.fact.statement });
      }
      if (ev.quote.trim() !== best.fact.statement.trim()) repaired = true;
    } else {
      repaired = true;
    }
  }

  if (grounded.length === 0) {
    return { card: null, repaired: true, reason: "all evidence ungrounded" };
  }

  // Keep factIds aligned with the evidence that actually survived.
  const keptIds = new Set<string>();
  for (const g of grounded) {
    const f = facts.find((x) => x.source === g.source && x.statement === g.quote);
    if (f) keptIds.add(f.id);
  }

  return {
    card: {
      ...card,
      evidence: grounded,
      factIds: keptIds.size > 0 ? [...keptIds] : card.factIds,
    },
    repaired,
  };
}
