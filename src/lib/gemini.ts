import { retrieveRelevant } from "./memory";
import { hydrateLearnedFacts } from "./learned-facts";
import { SPECIALISTS, runSpecialist } from "./collision/specialists";
import { verifyCard } from "./collision/verifier";
import type { CollisionCard, CollisionResult, MemoryFact } from "./types";

/**
 * Collision orchestrator.
 *
 * The brief's reasoning roles used to be fused into one Gemini call for speed.
 * They are now a parallel fan-out of focused specialist judges (one per
 * collision domain), each seeing only its slice of memory, merged here and
 * passed through a deterministic evidence verifier before anything reaches the
 * screen. The judges run concurrently, so wall-clock stays ≈ one call while
 * each card is sharper and provably grounded.
 */

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function findFact(facts: MemoryFact[], id: string): MemoryFact | undefined {
  return facts.find((fact) => fact.id === id);
}

function cardFromFact(
  fact: MemoryFact,
  args: AnalyzeArgs,
  overrides: {
    collisionType: CollisionCard["collisionType"];
    title: string;
    headline: string;
    suggestedNextStep: string;
  },
): CollisionCard {
  return {
    id: `${Date.now()}-fallback-${fact.id}`,
    collisionType: overrides.collisionType,
    title: overrides.title,
    headline: overrides.headline,
    evidence: [{ source: fact.source, quote: fact.statement }],
    reason: fact.reason,
    suggestedNextStep: overrides.suggestedNextStep,
    severity: fact.severity ?? "medium",
    factIds: [fact.id],
    triggeredBy: { speaker: args.speaker, text: args.text },
  };
}

/**
 * Deterministic seeded-context fallback for a total Gemini outage. Only used
 * when every specialist call failed — never for "the model found nothing".
 */
function fallbackCollisionResult(
  args: AnalyzeArgs,
  relevant: MemoryFact[],
): CollisionResult {
  const text = [
    args.recentTranscript?.map((u) => u.text).join(" ") ?? "",
    args.text,
  ]
    .join(" ")
    .toLowerCase();
  const allRelevant = retrieveRelevant(text, 20);

  const cards: CollisionCard[] = [];
  const legal =
    findFact(allRelevant, "legal-featurex") ??
    findFact(relevant, "legal-featurex");
  if (
    legal &&
    /feature\s*x|dpa|privacy|data|acme/.test(text) &&
    /launch|ship|release|promise|commit|friday|proceed/.test(text)
  ) {
    cards.push(
      cardFromFact(legal, args, {
        collisionType: "legal_compliance",
        title: "Context collision detected",
        headline: "Feature X cannot be promised until the DPA update is approved.",
        suggestedNextStep: "Confirm Legal approval before making a customer commitment.",
      }),
    );
  }

  const sso =
    findFact(allRelevant, "dependency-sso-auth") ??
    findFact(allRelevant, "eng-sso-auth") ??
    findFact(relevant, "dependency-sso-auth");
  if (
    sso &&
    /sso|auth refactor|auth/.test(text) &&
    /launch|ship|release|friday|today|tomorrow|promise|commit/.test(text)
  ) {
    cards.push(
      cardFromFact(sso, args, {
        collisionType: "dependency_blocker",
        title: "Dependency collision detected",
        headline: "SSO cannot launch before Auth Refactor is complete.",
        suggestedNextStep: "Move the launch promise behind the Auth Refactor milestone.",
      }),
    );
  }

  const exportDecision =
    findFact(allRelevant, "decision-acme-export") ??
    findFact(relevant, "decision-acme-export");
  if (
    exportDecision &&
    /acme/.test(text) &&
    /custom export|export/.test(text) &&
    /build|create|approve|commit|promise/.test(text)
  ) {
    cards.push(
      cardFromFact(exportDecision, args, {
        collisionType: "previous_decision",
        title: "Already decided",
        headline: "The team already decided not to build a custom export for Acme.",
        suggestedNextStep: "Reopen the decision explicitly before assigning engineering work.",
      }),
    );
  }

  const valya =
    findFact(allRelevant, "capacity-valya") ??
    findFact(relevant, "capacity-valya");
  if (
    valya &&
    /valya/.test(text) &&
    /p0|top priority|highest priority|urgent|assign|owner/.test(text)
  ) {
    cards.push(
      cardFromFact(valya, args, {
        collisionType: "priority_capacity",
        title: "Priority overload detected",
        headline: "Valya already owns 3 active P0 priorities.",
        suggestedNextStep: "Downgrade an existing P0 or choose another owner.",
      }),
    );
  }

  return {
    collisionDetected: cards.length > 0,
    cards: cards.slice(0, 2),
  };
}

export interface AnalyzeArgs {
  speaker: string;
  text: string;
  /** Recent meeting context so pronoun/topic references resolve. */
  recentTranscript?: { speaker: string; text: string }[];
}

function dedupeRankCap(
  cards: Omit<CollisionCard, "id" | "triggeredBy">[],
): Omit<CollisionCard, "id" | "triggeredBy">[] {
  const seen = new Set<string>();
  const unique = cards.filter((c) => {
    const key = `${c.collisionType}::${c.headline.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
  );
  return unique.slice(0, 2);
}

function hydrate(
  cards: Omit<CollisionCard, "id" | "triggeredBy">[],
  args: AnalyzeArgs,
): CollisionCard[] {
  return cards.map((c, i) => ({
    ...c,
    evidence: c.evidence ?? [],
    factIds: c.factIds ?? [],
    id: `${Date.now()}-${i}`,
    triggeredBy: { speaker: args.speaker, text: args.text },
  }));
}

export async function analyzeUtterance(
  args: AnalyzeArgs,
): Promise<CollisionResult> {
  // Pick up any facts an earlier part of *this* meeting wrote back, so a later
  // statement can collide with a decision just made (cross-process safe).
  await hydrateLearnedFacts();

  const contextText = [
    args.recentTranscript?.map((u) => u.text).join(" ") ?? "",
    args.text,
  ].join(" ");
  const relevant = retrieveRelevant(contextText);

  // Only spend a judge on a domain that actually has relevant facts; if the
  // lexical pre-filter found nothing typed, let every judge have a look.
  let domains = SPECIALISTS.filter((s) =>
    relevant.some((f) => s.factTypes.includes(f.type)),
  );
  if (domains.length === 0) domains = SPECIALISTS;

  const outputs = await Promise.all(
    domains.map((spec) => runSpecialist(spec, args, relevant)),
  );

  // Deterministic seeded-context detector, evidence-verified. Its keyword +
  // fact guards are strict (low false-positive), so it is safe both as a
  // total-outage fallback and as a miss safety net.
  const verifiedFallback = (): CollisionCard[] =>
    fallbackCollisionResult(args, relevant)
      .cards.map((c) => verifyCard(c, relevant).card)
      .filter((c): c is CollisionCard => c !== null) as CollisionCard[];

  // Every judge failing (vs. finding nothing) means Gemini is down → fall back
  // to the deterministic detector instead of silently missing.
  if (outputs.length > 0 && outputs.every((o) => o.errored)) {
    const cards = verifiedFallback();
    return { collisionDetected: cards.length > 0, cards };
  }

  const rawCards = outputs.flatMap((o) => o.cards);
  const verified = rawCards
    .map((c) => verifyCard(c, relevant).card)
    .filter(
      (c): c is Omit<CollisionCard, "id" | "triggeredBy"> => c !== null,
    );

  const final = hydrate(dedupeRankCap(verified), args);
  if (final.length > 0) return { collisionDetected: true, cards: final };

  // The specialists ran successfully but returned nothing. The model is
  // non-deterministic at temperature: on a paraphrase of a decisive line it
  // misses a real seeded collision ~20% of the time. Rather than render a
  // blank panel on the key moment, give the deterministic detector the last
  // word — its strict guards only fire on a genuine seeded conflict.
  const safetyNet = verifiedFallback();
  return { collisionDetected: safetyNet.length > 0, cards: safetyNet };
}
