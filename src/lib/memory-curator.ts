import { Type } from "@google/genai";
import { generateContent } from "./ai-gateway";
import { allFacts } from "./memory";
import { appendLearnedFacts } from "./learned-facts";
import type { MemoryFact } from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Memory Curator (the write-back loop).
 *
 * The collision engine only ever read a static seed graph, so a decision made
 * at minute 2 of a meeting could be contradicted at minute 20 with nothing to
 * collide against. This scribe runs OFF the hot path: after a card is returned
 * it looks at the finalized utterance and, when the speaker actually commits to
 * something durable, writes it back as a memory fact. The next utterance then
 * collides against decisions made earlier in this very meeting — the graph
 * gets smarter as the meeting goes on.
 */

const FACT_TYPES = [
  "decision",
  "commitment",
  "dependency",
  "person_capacity",
  "legal_blocker",
  "engineering_blocker",
] as const;

const SYSTEM_INSTRUCTION = `You are the Memory Curator for a live company meeting.

You are given:
1. The latest finalized utterance.
2. A short recent transcript window.
3. The facts already in the company memory graph (seed + already learned).

Extract ONLY new, durable facts the meeting just established that are NOT
already represented in the graph:
- a decision the team made,
- a commitment/promise to a customer or internally,
- a timeline or dependency that now gates work,
- a change to who owns what or someone's priority load.

Hard rules:
- Do NOT restate, rephrase, or slightly reword a fact that already exists.
- Do NOT record questions, brainstorming, hypotheticals, or vague intent.
- Only record something a reasonable person would treat as now-true going
  forward in this meeting.
- statement must be self-contained and quotable (a later card may cite it).
- Prefer zero facts over a weak or speculative one. Most utterances yield none.

Fields:
- type: one of decision | commitment | dependency | person_capacity |
  legal_blocker | engineering_blocker.
- entity: the primary subject (feature, project, person, customer).
- related: a few loose related terms for retrieval.
- statement: the fact, phrased so it can be quoted verbatim in a warning card.
- reason: the risk/why, only if the meeting actually stated it.
- severity: high | medium | low.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    facts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: [...FACT_TYPES] },
          entity: { type: Type.STRING },
          related: { type: Type.ARRAY, items: { type: Type.STRING } },
          statement: { type: Type.STRING },
          reason: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
        },
        required: ["type", "entity", "statement", "severity"],
      },
    },
  },
  required: ["facts"],
};

export interface CurateArgs {
  speaker: string;
  text: string;
  recentTranscript?: { speaker: string; text: string }[];
}

interface CuratedFact {
  type?: string;
  entity?: string;
  related?: string[];
  statement?: string;
  reason?: string;
  severity?: string;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * Analyze one utterance and persist any new durable facts. Returns the facts
 * that were written. Additive and best-effort: if Gemini is unavailable it
 * simply records nothing — it must never throw into the caller's hot path.
 */
export async function curateMemory(
  args: CurateArgs,
): Promise<MemoryFact[]> {
  const text = args.text?.trim();
  if (!text) return [];

  const existing = allFacts().map((f) => ({
    type: f.type,
    entity: f.entity,
    statement: f.statement,
  }));

  const prompt = JSON.stringify(
    {
      latestUtterance: { speaker: args.speaker, text },
      recentTranscript: args.recentTranscript ?? [],
      existingFacts: existing,
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
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.1,
        maxOutputTokens: 700,
      },
    });
    raw = response.text;
  } catch (err) {
    console.warn(
      "[curator] memory curation skipped (Gemini unavailable):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  if (!raw) return [];

  let parsed: { facts?: CuratedFact[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const now = Date.now();
  const candidates: MemoryFact[] = (parsed.facts ?? [])
    .filter(
      (f) =>
        f.statement &&
        f.entity &&
        (FACT_TYPES as readonly string[]).includes(f.type ?? ""),
    )
    .map((f, i) => ({
      id: `learned-${slug(f.entity ?? "fact")}-${now}-${i}`,
      type: f.type as MemoryFact["type"],
      entity: f.entity as string,
      related: f.related ?? [],
      status: "active",
      source: `Live meeting · ${args.speaker}`,
      statement: f.statement as string,
      reason: f.reason || undefined,
      severity:
        f.severity === "high" || f.severity === "low" ? f.severity : "medium",
    }));

  if (candidates.length === 0) return [];

  const before = allFacts().length;
  await appendLearnedFacts(candidates);
  const persisted = candidates.slice(0, Math.max(0, allFacts().length - before));
  if (persisted.length > 0) {
    console.log(
      `[curator] wrote back ${persisted.length} fact(s) from ${args.speaker}`,
    );
  }
  return persisted;
}
