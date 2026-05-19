// Layer 2 — per-utterance entity resolution sidecar. Runs in PARALLEL with the
// collision hot path; it never blocks it. For each Speechmatics final we
// produce a non-destructive {@link EnhancedUtterance} overlay: fuzzy spans,
// optionally an LLM disambiguation when ambiguous, plus deterministic
// relative-date normalization. The raw text is never mutated and is still
// what cards quote.

import { Type } from "@google/genai";
import { generateContent } from "@/lib/ai-gateway";
import { allFacts } from "@/lib/memory";
import type { MemoryFact, RawUtterance } from "@/lib/types";
import { buildKb, fuzzyMatch, lookupLabel } from "./resolver-client";
import type {
  EnhancedUtterance,
  NumericNormalization,
  Resolution,
  ResolverCandidate,
} from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** A span is only resolved when confidence reaches this. */
export const RESOLUTION_CONFIDENCE_THRESHOLD = 0.8;

/** Hard wall-clock budget for the whole resolve pass. */
export const RESOLUTION_BUDGET_MS = 500;

/** A fuzzy match this strong is unambiguous — no LLM call needed. */
const FUZZY_CONFIDENT = 0.92;

export interface ResolveArgs {
  raw: RawUtterance;
  /** Prior utterances for disambiguation context (most recent last). */
  recent?: { speakerId: string; text: string }[];
  /** Snapshot of the graph to resolve against (defaults to live graph). */
  facts?: MemoryFact[];
}

const llmResponseSchema = {
  type: Type.OBJECT,
  properties: {
    canonicalEntityId: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
  },
  required: ["canonicalEntityId", "confidence"],
};

/**
 * One Gemini call to choose between ambiguous candidates for a single span.
 * Returns null on any failure / low confidence — partial enhancement is fine
 * and a gateway outage must never throw out of here.
 */
async function disambiguate(
  raw: RawUtterance,
  cand: ResolverCandidate,
  candidates: ResolverCandidate[],
  recent: { speakerId: string; text: string }[],
): Promise<{ canonicalEntityId: string; confidence: number } | null> {
  const prompt = JSON.stringify(
    {
      utterance: raw.text,
      span: cand.rawText,
      priorUtterances: recent.slice(-3).map((u) => u.text),
      candidates: candidates.map((c) => ({
        canonicalEntityId: c.canonicalEntityId,
        canonicalLabel: c.canonicalLabel,
      })),
    },
    null,
    2,
  );

  try {
    const { response } = await generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction:
          "You disambiguate which knowledge-graph entity a phrase in a " +
          "meeting utterance refers to. Choose exactly one canonicalEntityId " +
          "from the candidates, or return an empty canonicalEntityId with " +
          "confidence 0 if none fit. confidence is your 0..1 certainty.",
        responseMimeType: "application/json",
        responseSchema: llmResponseSchema,
        temperature: 0,
        maxOutputTokens: 80,
      },
    });
    const raw0 = response.text;
    if (!raw0) return null;
    const parsed = JSON.parse(raw0) as {
      canonicalEntityId?: string;
      confidence?: number;
    };
    if (!parsed.canonicalEntityId) return null;
    return {
      canonicalEntityId: parsed.canonicalEntityId,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch (err) {
    // Gateway down / malformed output → skip Layer 2 for this span.
    console.warn(
      "[entity-resolver] disambiguation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ───────────────── deterministic relative-date normalization ────────────────

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function iso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Days until the next occurrence of `weekday` (1..7, never 0/today). */
function daysUntilWeekday(from: Date, weekday: number): number {
  const cur = from.getUTCDay();
  const delta = (weekday - cur + 7) % 7;
  return delta === 0 ? 7 : delta;
}

interface DateMatch {
  span: [number, number];
  rawText: string;
  normalized: string;
  confidence: number;
}

/**
 * Best-effort, LLM-free parser for the obvious relative-date cases:
 * today / tomorrow / yesterday, "next <weekday>", "this <weekday>",
 * "next week". Anything ambiguous is left alone (confidence-gated by simply
 * not emitting it).
 */
function normalizeDates(text: string, now: Date): DateMatch[] {
  const out: DateMatch[] = [];

  const simple: [RegExp, (m: RegExpExecArray) => Date | null, number][] = [
    [/\btoday\b/gi, () => now, 0.99],
    [/\btomorrow\b/gi, () => addDays(now, 1), 0.99],
    [/\byesterday\b/gi, () => addDays(now, -1), 0.99],
    [/\bnext week\b/gi, () => addDays(now, 7), 0.85],
  ];
  for (const [re, fn, conf] of simple) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const d = fn(m);
      if (!d) continue;
      out.push({
        span: [m.index, m.index + m[0].length],
        rawText: m[0],
        normalized: iso(d),
        confidence: conf,
      });
    }
  }

  // "next Friday" / "this Tuesday" / bare "Friday" (= upcoming).
  const wdRe =
    /\b(next|this|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
  let wm: RegExpExecArray | null;
  while ((wm = wdRe.exec(text)) !== null) {
    const qualifier = (wm[1] || "").toLowerCase();
    const weekday = WEEKDAYS.indexOf(wm[2].toLowerCase());
    if (weekday < 0) continue;
    let target: Date;
    let confidence: number;
    if (qualifier === "next") {
      target = addDays(now, daysUntilWeekday(now, weekday) + 7);
      confidence = 0.85;
    } else {
      target = addDays(now, daysUntilWeekday(now, weekday));
      confidence = qualifier === "this" || qualifier === "coming" ? 0.85 : 0.8;
    }
    out.push({
      span: [wm.index, wm.index + wm[0].length],
      rawText: wm[0],
      normalized: iso(target),
      confidence,
    });
  }

  // Drop overlaps (keep the first / longer); keep deterministic order.
  out.sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const kept: DateMatch[] = [];
  for (const m of out) {
    if (kept.some((k) => m.span[0] < k.span[1] && k.span[0] < m.span[1])) {
      continue;
    }
    kept.push(m);
  }
  return kept;
}

/**
 * Core resolution (no budget wrapper). Fuzzy-match spans; strong matches are
 * accepted as `method: 'fuzzy'`; ambiguous ones (multiple candidates and no
 * dominant fuzzy score) get a single LLM call. Confidence-gated at
 * {@link RESOLUTION_CONFIDENCE_THRESHOLD}. Relative dates are normalized
 * deterministically.
 */
async function resolveCore(args: ResolveArgs): Promise<EnhancedUtterance> {
  const { raw } = args;
  const facts = args.facts ?? allFacts();
  const recent = args.recent ?? [];

  const result: EnhancedUtterance = {
    rawUtteranceId: raw.id,
    resolutions: [],
    numericNormalizations: [],
  };

  // Numeric / temporal normalization (deterministic, confidence-gated).
  for (const dm of normalizeDates(raw.text, new Date())) {
    if (dm.confidence < RESOLUTION_CONFIDENCE_THRESHOLD) continue;
    const n: NumericNormalization = {
      span: dm.span,
      rawText: dm.rawText,
      normalized: dm.normalized,
      confidence: dm.confidence,
    };
    result.numericNormalizations.push(n);
  }

  if (raw.text.trim().length === 0) return result;

  const kb = buildKb(facts);
  const candidates = fuzzyMatch(raw.text, kb);

  for (const cand of candidates) {
    if (cand.score >= FUZZY_CONFIDENT) {
      // Unambiguous — accept the fuzzy match directly.
      if (cand.score >= RESOLUTION_CONFIDENCE_THRESHOLD) {
        const r: Resolution = {
          span: cand.span,
          rawText: cand.rawText,
          canonicalEntityId: cand.canonicalEntityId,
          canonicalLabel: cand.canonicalLabel,
          confidence: cand.score,
          method: "fuzzy",
        };
        result.resolutions.push(r);
      }
      continue;
    }

    // Ambiguous: ask the model to pick among the full candidate set.
    const choice = await disambiguate(raw, cand, candidates, recent);
    if (!choice) continue;
    if (choice.confidence < RESOLUTION_CONFIDENCE_THRESHOLD) continue;
    const label =
      lookupLabel(choice.canonicalEntityId, facts) ?? cand.canonicalLabel;
    const r: Resolution = {
      span: cand.span,
      rawText: cand.rawText,
      canonicalEntityId: choice.canonicalEntityId,
      canonicalLabel: label,
      confidence: choice.confidence,
      method: "llm",
    };
    result.resolutions.push(r);
  }

  return result;
}

/** "No enhancement" overlay — raw passes through downstream untouched. */
function passthrough(raw: RawUtterance): EnhancedUtterance {
  return { rawUtteranceId: raw.id, resolutions: [], numericNormalizations: [] };
}

/**
 * Public entry point. Enforces the {@link RESOLUTION_BUDGET_MS} budget with a
 * Promise.race: if resolution (the LLM hop) overruns, we return the raw
 * passthrough so the downstream NLU lane never stalls. The enhancer "catches
 * up" only when it can do so within budget — partial enhancement is fine.
 */
export async function resolveUtterance(
  args: ResolveArgs,
  budgetMs: number = RESOLUTION_BUDGET_MS,
): Promise<EnhancedUtterance> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EnhancedUtterance>((resolve) => {
    timer = setTimeout(() => resolve(passthrough(args.raw)), budgetMs);
  });
  try {
    return await Promise.race([
      resolveCore(args).catch((err) => {
        // Defensive: resolveCore swallows its own errors, but never throw.
        console.warn(
          "[entity-resolver] resolve failed:",
          err instanceof Error ? err.message : err,
        );
        return passthrough(args.raw);
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const __test__ = { normalizeDates, resolveCore, daysUntilWeekday };
