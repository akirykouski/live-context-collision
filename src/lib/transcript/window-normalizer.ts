// Layer 3 — sliding-window normalization. Every ~75s (with 30s overlap) we
// look back over the last ~2 minutes of utterances and resolve the things that
// need *forward* context: pronouns and cross-references ("the migration we
// discussed" → which migration?). The output is an overlay consumed ONLY by
// the memory curator and the post-meeting summary — never the collision hot
// path, which must not wait. Best-effort: a gateway failure yields an empty
// overlay, never a throw.

import { Type } from "@google/genai";
import { generateContent } from "@/lib/ai-gateway";
import { allFacts } from "@/lib/memory";
import type { MemoryFact, RawUtterance } from "@/lib/types";
import type {
  NormalizedWindow,
  ReferenceResolution,
  TopicAnchor,
} from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Cadence the scheduler is expected to call this at. */
export const WINDOW_INTERVAL_MS = 75_000;
/** Overlap kept between windows so a boundary doesn't cut a reference. */
export const WINDOW_OVERLAP_MS = 30_000;
/** How far back a single window looks. */
export const WINDOW_SPAN_MS = 120_000;

export const WINDOW_CONFIDENCE_THRESHOLD = 0.8;

export interface NormalizeArgs {
  /** The window of raw utterances, oldest first. */
  utterances: RawUtterance[];
  /** Graph snapshot to anchor references against (defaults to live graph). */
  facts?: MemoryFact[];
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    referenceResolutions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rawUtteranceId: { type: Type.STRING },
          referenceText: { type: Type.STRING },
          canonicalEntityId: { type: Type.STRING },
          canonicalLabel: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: [
          "rawUtteranceId",
          "referenceText",
          "canonicalEntityId",
          "canonicalLabel",
          "confidence",
        ],
      },
    },
    topicAnchors: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          rawUtteranceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["label", "rawUtteranceIds"],
      },
    },
  },
  required: ["referenceResolutions", "topicAnchors"],
};

const SYSTEM_INSTRUCTION =
  "You normalize a short window of meeting transcript. Resolve pronouns and " +
  "cross-references ('the migration we discussed', 'that decision', 'it') to " +
  "the knowledge-graph entity they refer to, using the candidate entities and " +
  "the surrounding utterances for forward/backward context. Also list the " +
  "main topic anchors and which utterance ids established them. Only emit a " +
  "reference resolution you are confident about; confidence is 0..1. Never " +
  "invent an entity id that is not in the candidates.";

function empty(args: NormalizeArgs): NormalizedWindow {
  const ids = args.utterances.map((u) => u.id);
  return {
    windowStartId: ids[0] ?? "",
    windowEndId: ids[ids.length - 1] ?? "",
    referenceResolutions: [],
    topicAnchors: [],
  };
}

/**
 * Pure-ish function over the window: one Gemini call, then a confidence gate
 * and a validity gate (the resolved entity id must be a real candidate / a
 * window utterance id). Tolerates gateway failure → empty overlay.
 */
export async function normalizeWindow(
  args: NormalizeArgs,
): Promise<NormalizedWindow> {
  const { utterances } = args;
  if (utterances.length === 0) return empty(args);

  const facts = args.facts ?? allFacts();
  const validEntityIds = new Set(facts.map((f) => f.id));
  const validUtteranceIds = new Set(utterances.map((u) => u.id));

  const prompt = JSON.stringify(
    {
      window: utterances.map((u) => ({
        id: u.id,
        speakerId: u.speakerId,
        text: u.text,
      })),
      candidateEntities: facts.map((f) => ({
        canonicalEntityId: f.id,
        canonicalLabel: f.entity,
        related: f.related ?? [],
      })),
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
        maxOutputTokens: 1200,
      },
    });
    raw = response.text;
  } catch (err) {
    // Layer 3 is off the hot path and strictly additive — degrade silently.
    console.warn(
      "[window-normalizer] gateway failure, empty overlay:",
      err instanceof Error ? err.message : err,
    );
    return empty(args);
  }

  if (!raw) return empty(args);

  let parsed: {
    referenceResolutions?: ReferenceResolution[];
    topicAnchors?: TopicAnchor[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty(args);
  }

  const referenceResolutions = (parsed.referenceResolutions ?? []).filter(
    (r) =>
      r &&
      typeof r.confidence === "number" &&
      r.confidence >= WINDOW_CONFIDENCE_THRESHOLD &&
      validUtteranceIds.has(r.rawUtteranceId) &&
      validEntityIds.has(r.canonicalEntityId),
  );

  const topicAnchors = (parsed.topicAnchors ?? [])
    .filter((t) => t && typeof t.label === "string" && Array.isArray(t.rawUtteranceIds))
    .map((t) => ({
      label: t.label,
      rawUtteranceIds: t.rawUtteranceIds.filter((id) =>
        validUtteranceIds.has(id),
      ),
    }))
    .filter((t) => t.rawUtteranceIds.length > 0);

  return {
    windowStartId: utterances[0].id,
    windowEndId: utterances[utterances.length - 1].id,
    referenceResolutions,
    topicAnchors,
  };
}

export const __test__ = { empty };
