// Transcript Enhancer types. The raw transcript primitives live in the shared
// cross-feature seam (`@/lib/types`) so the Enhancer and the Pre-Warmer never
// drift; everything here is enrichment that *references* the raw by id and
// never mutates it.

import type { AdditionalVocabEntry, RawUtterance } from "@/lib/types";

export type { AdditionalVocabEntry, RawUtterance };

/** How a span was resolved to a graph entity. */
export type ResolutionMethod = "fuzzy" | "llm";

/**
 * One resolved span inside a raw utterance. `span` is a pair of character
 * offsets into the raw text — the raw text itself is never rewritten, the
 * resolution is an overlay keyed by offsets so the card layer can always quote
 * verbatim.
 */
export interface Resolution {
  /** [start, end) char offsets into the raw utterance text. */
  span: [number, number];
  /** Exactly what was said in that span (verbatim slice of raw). */
  rawText: string;
  /** Graph node id this span resolves to. */
  canonicalEntityId: string;
  /** Human-readable label for the canonical entity (downstream display). */
  canonicalLabel: string;
  /** 0..1 — only emitted when >= RESOLUTION_CONFIDENCE_THRESHOLD. */
  confidence: number;
  method: ResolutionMethod;
}

/**
 * A normalized numeric/temporal expression ("next Friday" → an ISO date).
 * Best-effort and confidence-gated; raw text is still canonical.
 */
export interface NumericNormalization {
  /** [start, end) char offsets into the raw utterance text. */
  span: [number, number];
  /** Verbatim slice ("next Friday"). */
  rawText: string;
  /** Normalized form ("2026-05-23"). */
  normalized: string;
  /** 0..1 — only emitted when >= RESOLUTION_CONFIDENCE_THRESHOLD. */
  confidence: number;
}

/**
 * The Layer 2 output: a non-destructive overlay over one immutable raw
 * utterance. Downstream NLU consumers may read resolutions/normalizations as
 * lookup keys; the collision card layer must still quote the raw text.
 */
export interface EnhancedUtterance {
  /** Points at the immutable {@link RawUtterance}. */
  rawUtteranceId: string;
  resolutions: Resolution[];
  numericNormalizations: NumericNormalization[];
}

/** A pronoun / cross-reference resolved across a window of utterances. */
export interface ReferenceResolution {
  /** The raw utterance the reference appeared in. */
  rawUtteranceId: string;
  /** The referring phrase ("the migration we discussed"). */
  referenceText: string;
  /** Graph node / topic anchor it points at. */
  canonicalEntityId: string;
  canonicalLabel: string;
  confidence: number;
}

/** A topic the window settled on, with the utterances that anchor it. */
export interface TopicAnchor {
  label: string;
  /** Raw utterance ids that established / discussed this topic. */
  rawUtteranceIds: string[];
}

/**
 * The Layer 3 output: an overlay over the last ~2 minutes of utterances.
 * Consumed only by the memory curator and post-meeting summary — never the
 * collision hot path.
 */
export interface NormalizedWindow {
  /** Inclusive raw utterance id range this window covers. */
  windowStartId: string;
  windowEndId: string;
  referenceResolutions: ReferenceResolution[];
  topicAnchors: TopicAnchor[];
}

/** A fuzzy candidate produced by the resolver-client over the memory graph. */
export interface ResolverCandidate {
  canonicalEntityId: string;
  canonicalLabel: string;
  /** 0..1 lexical similarity of the matched span to this entity. */
  score: number;
  /** [start, end) offsets of the matched span in the source text. */
  span: [number, number];
  /** The raw substring that matched. */
  rawText: string;
}
