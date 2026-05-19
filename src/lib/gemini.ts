import { Type } from "@google/genai";
import { generateContent } from "./ai-gateway";
import { retrieveRelevant } from "./memory";
import type { CollisionCard, CollisionResult, MemoryFact } from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * The brief defines six agent roles (Transcript, Decision Extractor, Memory
 * Retrieval, Collision Judge, Evidence Formatter, Resolution). For a live demo,
 * latency is the product — so retrieval runs locally and the remaining four
 * reasoning roles are fused into one structured Gemini call.
 */
const SYSTEM_INSTRUCTION = `You are the Live Context Collision engine for a company meeting.

You are given:
1. The latest spoken utterance from a live meeting.
2. A set of facts retrieved from the company memory graph.

Do this:
- Decide whether the speaker is PROPOSING something consequential: a decision,
  a promise/commitment, a timeline, an assignment, or a priority change.
- If yes, check each statement against the memory facts for a real CONFLICT.
- Only raise a card when there is a genuine collision backed by a specific fact.
  Casual talk, questions with no proposal, or aligned statements => no card.

Collision types:
- legal_compliance: proposal conflicts with a legal/privacy/compliance blocker.
- previous_decision: proposal reopens or contradicts an already-made decision.
- priority_capacity: a new P0/top priority ignores owner capacity or the
  "no new P0 without downgrading one" rule.
- dependency_blocker: a timeline/promise ignores a known dependency or blocker.
- customer_promise: a plan conflicts with what was promised to a customer.

Card rules:
- title: short, e.g. "Context collision detected", "Already decided",
  "Priority overload detected", "Dependency collision detected".
- headline: one crisp sentence naming the conflict.
- evidence: quote the memory facts that prove it, each with its source. Quote
  faithfully; do not invent sources or numbers.
- reason: the underlying risk, if present in the facts.
- suggestedNextStep: one concrete, safe next action. Keep it short.
- severity: high | medium | low.
- factIds: the ids of the memory facts you used.
Be terse. A judge reads this in 3 seconds during a live meeting.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    collisionDetected: { type: Type.BOOLEAN },
    cards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          collisionType: {
            type: Type.STRING,
            enum: [
              "legal_compliance",
              "previous_decision",
              "priority_capacity",
              "dependency_blocker",
              "customer_promise",
            ],
          },
          title: { type: Type.STRING },
          headline: { type: Type.STRING },
          evidence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                source: { type: Type.STRING },
                quote: { type: Type.STRING },
              },
              required: ["source", "quote"],
            },
          },
          reason: { type: Type.STRING },
          suggestedNextStep: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
          factIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          "collisionType",
          "title",
          "headline",
          "evidence",
          "severity",
          "factIds",
        ],
      },
    },
  },
  required: ["collisionDetected", "cards"],
};

function factForPrompt(f: MemoryFact) {
  return {
    id: f.id,
    type: f.type,
    entity: f.entity,
    status: f.status,
    source: f.source,
    statement: f.statement,
    reason: f.reason,
    activeP0s: f.activeP0s,
    rule: f.rule,
    severity: f.severity,
  };
}

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
  const allFacts = retrieveRelevant(text, 20);

  const cards: CollisionCard[] = [];
  const legal = findFact(allFacts, "legal-featurex") ?? findFact(relevant, "legal-featurex");
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
    findFact(allFacts, "dependency-sso-auth") ??
    findFact(allFacts, "eng-sso-auth") ??
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
    findFact(allFacts, "decision-acme-export") ??
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

  const valya = findFact(allFacts, "capacity-valya") ?? findFact(relevant, "capacity-valya");
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

export async function analyzeUtterance(
  args: AnalyzeArgs,
): Promise<CollisionResult> {
  const relevant = retrieveRelevant(
    [args.recentTranscript?.map((u) => u.text).join(" ") ?? "", args.text].join(
      " ",
    ),
  );

  const prompt = JSON.stringify(
    {
      latestUtterance: { speaker: args.speaker, text: args.text },
      recentTranscript: args.recentTranscript ?? [],
      memoryFacts: relevant.map(factForPrompt),
    },
    null,
    2,
  );

  let raw: string | undefined;
  try {
    const { response: res } = await generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
        // Snappy on stage; the schema keeps output small anyway.
        maxOutputTokens: 1200,
      },
    });
    raw = res.text;
  } catch (err) {
    console.warn(
      "[collision] Gemini unavailable, using seeded-context fallback:",
      err instanceof Error ? err.message : err,
    );
    return fallbackCollisionResult(args, relevant);
  }

  if (!raw) return { collisionDetected: false, cards: [] };

  let parsed: { collisionDetected: boolean; cards: Omit<CollisionCard, "id" | "triggeredBy">[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { collisionDetected: false, cards: [] };
  }

  const cards: CollisionCard[] = (parsed.cards ?? []).map((c, i) => ({
    ...c,
    evidence: c.evidence ?? [],
    factIds: c.factIds ?? [],
    id: `${Date.now()}-${i}`,
    triggeredBy: { speaker: args.speaker, text: args.text },
  }));

  return {
    collisionDetected: parsed.collisionDetected && cards.length > 0,
    cards,
  };
}
