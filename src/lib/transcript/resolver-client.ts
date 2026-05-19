// Shared fuzzy match + knowledge-base lookup. Used by Layer 2 (per-utterance
// resolution) and Layer 3 (window normalization) to propose candidate graph
// entities for a span of text. Pure + synchronous over the in-process memory
// graph snapshot — no network, no LLM.

import { allFacts } from "@/lib/memory";
import type { MemoryFact } from "@/lib/types";
import type { ResolverCandidate } from "./types";

/** A KB entry the fuzzy matcher ranks spans against. */
export interface KbEntity {
  /** Canonical graph node id. For facts this is the fact id. */
  canonicalEntityId: string;
  /** Display label (the primary entity string). */
  canonicalLabel: string;
  /** All surface forms that should match this entity, lowercased. */
  surfaceForms: string[];
}

function uniqueLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase().trim();
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Build the KB from the live memory graph. Each fact contributes its primary
 * entity plus its related terms as surface forms keyed to the fact id.
 */
export function buildKb(facts: MemoryFact[] = allFacts()): KbEntity[] {
  return facts.map((f) => ({
    canonicalEntityId: f.id,
    canonicalLabel: f.entity,
    surfaceForms: uniqueLower([
      f.entity,
      ...(f.related ?? []),
      ...(f.activeP0s ?? []),
    ]),
  }));
}

/** Levenshtein distance, capped early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 0..1 similarity from edit distance over the longer string. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  const d = editDistance(a, b, longer);
  return 1 - d / longer;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "for",
  "with",
  "on",
  "in",
  "is",
  "are",
  "we",
  "it",
  "that",
  "this",
]);

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

const MIN_FUZZY_SCORE = 0.78;

/**
 * Fuzzy-match candidate spans in `text` against the KB. Generates n-grams
 * (1..4 tokens) and scores each against every surface form, keeping the best
 * non-overlapping matches above {@link MIN_FUZZY_SCORE}. Returns ranked
 * candidates with char offsets into `text`.
 */
export function fuzzyMatch(
  text: string,
  kb: KbEntity[] = buildKb(),
  opts: { minScore?: number; maxCandidates?: number } = {},
): ResolverCandidate[] {
  const minScore = opts.minScore ?? MIN_FUZZY_SCORE;
  const maxCandidates = opts.maxCandidates ?? 5;
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const raw: ResolverCandidate[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= 4 && i + n <= tokens.length; n++) {
      const slice = tokens.slice(i, i + n);
      // Skip pure-stopword spans (e.g. "the", "we to").
      if (slice.every((t) => STOPWORDS.has(t.text.toLowerCase()))) continue;
      const start = slice[0].start;
      const end = slice[slice.length - 1].end;
      const phrase = text.slice(start, end);
      const phraseLower = phrase.toLowerCase();

      let best: { e: KbEntity; score: number } | null = null;
      for (const e of kb) {
        for (const form of e.surfaceForms) {
          const s = similarity(phraseLower, form);
          if (s >= minScore && (!best || s > best.score)) {
            best = { e, score: s };
          }
        }
      }
      if (best) {
        raw.push({
          canonicalEntityId: best.e.canonicalEntityId,
          canonicalLabel: best.e.canonicalLabel,
          score: best.score,
          span: [start, end],
          rawText: phrase,
        });
      }
    }
  }

  // Highest score first, then longest span, then earliest.
  raw.sort(
    (a, b) =>
      b.score - a.score ||
      b.rawText.length - a.rawText.length ||
      a.span[0] - b.span[0],
  );

  // Keep only non-overlapping spans.
  const taken: [number, number][] = [];
  const out: ResolverCandidate[] = [];
  for (const cand of raw) {
    const overlaps = taken.some(
      ([s, e]) => cand.span[0] < e && s < cand.span[1],
    );
    if (overlaps) continue;
    taken.push(cand.span);
    out.push(cand);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

/** Look up a single canonical label by id, from the live graph. */
export function lookupLabel(
  canonicalEntityId: string,
  facts: MemoryFact[] = allFacts(),
): string | null {
  const f = facts.find((x) => x.id === canonicalEntityId);
  return f ? f.entity : null;
}

export const __test__ = { editDistance, similarity, tokenize };
