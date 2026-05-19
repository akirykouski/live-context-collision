// Transcript Enhancer — public surface.
//
// Three additive layers that make downstream NLU input cleaner without ever
// rewriting what the user said:
//   Layer 1  dictionary-builder  → Speechmatics additional_vocab (prevention)
//   Layer 2  entity-resolver     → per-utterance resolution sidecar (~500ms)
//   Layer 3  window-normalizer   → 75s cross-reference window pass
//
// The collision hot path quotes the RAW transcript only; everything here is an
// overlay keyed by id/offset.

export * from "./types";
export {
  buildAdditionalVocab,
  VOCAB_CAP,
  type BuildVocabOptions,
} from "./dictionary-builder";
export {
  resolveUtterance,
  RESOLUTION_CONFIDENCE_THRESHOLD,
  RESOLUTION_BUDGET_MS,
  type ResolveArgs,
} from "./entity-resolver";
export {
  normalizeWindow,
  WINDOW_INTERVAL_MS,
  WINDOW_OVERLAP_MS,
  WINDOW_SPAN_MS,
  WINDOW_CONFIDENCE_THRESHOLD,
  type NormalizeArgs,
} from "./window-normalizer";
export {
  buildKb,
  fuzzyMatch,
  lookupLabel,
  type KbEntity,
} from "./resolver-client";
