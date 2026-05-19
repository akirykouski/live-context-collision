import { Type } from "@google/genai";
import { generateContent } from "../ai-gateway";
import { getValkey, hasValkey } from "../valkey";
import { prewarmKeys } from "../types";
import type { CollisionCard, CollisionType, MemoryFact } from "../types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Pre-Warmer integration seam (additive, safe, pure no-op without a meeting).
 *
 * The Pre-Warmer writes the ranked, meeting-relevant MemoryFact[] to
 * prewarmKeys.hot(meetingId) as a TRUE drop-in for what retrieveRelevant()
 * returns. The collision orchestrator calls {@link hotFactsFor} first and
 * falls back to the cold graph on a miss — the hot path never regresses.
 *
 * The integrator wires this into gemini.ts; this module only exposes the
 * helper + hit/miss counter. Never throws: any error → null (cold fallback).
 */
export const prewarmHitStats = { hits: 0, misses: 0 };

export async function hotFactsFor(
  meetingId?: string,
): Promise<MemoryFact[] | null> {
  // Pure no-op when there is no meeting context or no store.
  if (!meetingId || !hasValkey()) {
    return null;
  }
  try {
    const raw = await getValkey().get(prewarmKeys.hot(meetingId));
    if (!raw) {
      prewarmHitStats.misses++;
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      prewarmHitStats.misses++;
      return null;
    }
    prewarmHitStats.hits++;
    return parsed as MemoryFact[];
  } catch {
    // Malformed JSON / store hiccup must never break collision detection.
    prewarmHitStats.misses++;
    return null;
  }
}

/**
 * The brief defines six agent roles. Instead of one fused prompt that has to
 * juggle all five collision types at once, each collision domain is a focused
 * specialist judge with its own instruction and its own slice of the memory
 * graph. The orchestrator fans these out in parallel (so wall-clock stays ≈
 * one call) and only spends a judge on a domain that actually has relevant
 * facts. A sharper, single-purpose prompt is far less likely to miss or
 * conflate a collision than one prompt doing everyone's job.
 */
export interface Specialist {
  domain: CollisionType;
  /** Memory fact types this specialist is responsible for. */
  factTypes: MemoryFact["type"][];
  systemInstruction: string;
}

const CARD_RULES = `Card rules:
- title: short, judge-readable.
- headline: one crisp sentence naming the conflict.
- evidence: quote the memory facts that prove it, each with its source. Quote
  faithfully; never invent a source, number, or wording.
- reason: the underlying risk, only if it is present in the facts.
- suggestedNextStep: one concrete, safe next action. Keep it short.
- severity: high | medium | low.
- factIds: the ids of the memory facts you used.
Only raise a card on a GENUINE collision backed by a specific fact. Casual
talk, questions with no proposal, or aligned statements => no card. Be terse.`;

export const SPECIALISTS: Specialist[] = [
  {
    domain: "legal_compliance",
    factTypes: ["legal_blocker"],
    systemInstruction: `You are the Legal/Compliance collision judge for a live meeting.
Raise a card only when the speaker proposes shipping, promising, or proceeding
with something that a legal/privacy/compliance blocker forbids.
${CARD_RULES}`,
  },
  {
    domain: "previous_decision",
    factTypes: ["decision"],
    systemInstruction: `You are the Prior-Decision collision judge for a live meeting.
Raise a card only when the speaker reopens, contradicts, or quietly reverses a
decision the team already made, without explicitly acknowledging it.
${CARD_RULES}`,
  },
  {
    domain: "priority_capacity",
    factTypes: ["person_capacity"],
    systemInstruction: `You are the Priority/Capacity collision judge for a live meeting.
Raise a card only when a new P0/top priority or assignment ignores an owner's
existing load or the "no new P0 without downgrading one" rule.
${CARD_RULES}`,
  },
  {
    domain: "dependency_blocker",
    factTypes: ["engineering_blocker", "dependency"],
    systemInstruction: `You are the Dependency/Blocker collision judge for a live meeting.
Raise a card only when a timeline or promise ignores a known dependency or
engineering blocker that gates the work.
${CARD_RULES}`,
  },
  {
    domain: "customer_promise",
    factTypes: ["commitment"],
    systemInstruction: `You are the Customer-Promise collision judge for a live meeting.
Raise a card only when an internal plan conflicts with, or over-commits beyond,
what was promised to (or expected by) a customer.
${CARD_RULES}`,
  },
];

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    collisionDetected: { type: Type.BOOLEAN },
    cards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
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
        required: ["title", "headline", "evidence", "severity", "factIds"],
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

export interface SpecialistArgs {
  speaker: string;
  text: string;
  recentTranscript?: { speaker: string; text: string }[];
}

export interface SpecialistOutput {
  cards: Omit<CollisionCard, "id" | "triggeredBy">[];
  /** True when the model call failed (vs. simply finding no collision). */
  errored: boolean;
}

/**
 * Run one specialist over only its slice of the retrieved facts. Errors are
 * swallowed and reported via `errored` so a single key/quota hiccup on one
 * domain never takes down the other judges.
 */
export async function runSpecialist(
  spec: Specialist,
  args: SpecialistArgs,
  facts: MemoryFact[],
): Promise<SpecialistOutput> {
  const slice = facts.filter((f) => spec.factTypes.includes(f.type));
  if (slice.length === 0) return { cards: [], errored: false };

  const prompt = JSON.stringify(
    {
      latestUtterance: { speaker: args.speaker, text: args.text },
      recentTranscript: args.recentTranscript ?? [],
      memoryFacts: slice.map(factForPrompt),
    },
    null,
    2,
  );

  let raw: string | undefined;
  try {
    const { response } = await generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction: spec.systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
        maxOutputTokens: 900,
      },
    });
    raw = response.text;
  } catch (err) {
    console.warn(
      `[collision:${spec.domain}] specialist call failed:`,
      err instanceof Error ? err.message : err,
    );
    return { cards: [], errored: true };
  }

  if (!raw) return { cards: [], errored: false };

  let parsed: {
    collisionDetected?: boolean;
    cards?: Omit<CollisionCard, "id" | "triggeredBy" | "collisionType">[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON is the model's problem, not the key's — not an error
    // worth failing over to the deterministic fallback for.
    return { cards: [], errored: false };
  }

  if (!parsed.collisionDetected) return { cards: [], errored: false };

  const cards = (parsed.cards ?? []).map((c) => ({
    ...c,
    collisionType: spec.domain,
    evidence: c.evidence ?? [],
    factIds: c.factIds ?? [],
  }));

  return { cards, errored: false };
}
