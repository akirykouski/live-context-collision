// Ranker — spec 2.6.
//
//   score =
//       w_recency      * recency_decay(timestamp)              // exp, t½ = 7d
//     + w_overlap      * fraction_of_attendees_who_touched_it  // 0..1
//     + w_agenda       * cosine(agenda_bow, fact_bow)          // bag-of-words
//     + w_source_prior * source_weight                         // graph>…>slack
//     + w_explicit_ref * (fact entity in agenda entities)      // 0|1, heavy
//
// No embeddings / no network — agenda match is token-overlap cosine, which is
// deterministic and unit-testable. Dedup by candidate id and by normalized
// text. Returns the top-N RankedFact[] sorted descending.

import type { CandidateFact, PrewarmSource, RankedFact, UpcomingMeeting } from "./types";

/** Tunable weights. Exported so Phase 2 can A/B without code changes. */
export interface RankerWeights {
  w_recency: number;
  w_overlap: number;
  w_agenda: number;
  w_source_prior: number;
  w_explicit_ref: number;
}

export const RANKER_WEIGHTS: RankerWeights = {
  w_recency: 1.0,
  w_overlap: 1.5,
  w_agenda: 2.0,
  w_source_prior: 1.0,
  w_explicit_ref: 4.0,
};

/** graph > github > jira > notion > slack (calendar sits with graph: it is
 *  the agenda itself, the strongest explicit signal). */
export const SOURCE_PRIOR: Record<PrewarmSource, number> = {
  graph: 1.0,
  calendar: 0.95,
  github: 0.7,
  jira: 0.5,
  notion: 0.4,
  slack: 0.3,
};

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOP_N = 300;

export function recencyDecay(timestamp: number, now: number): number {
  const age = Math.max(0, now - timestamp);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function bag(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Token-overlap cosine similarity over bag-of-words. 0..1. */
export function bowCosine(a: string, b: string): number {
  const ba = bag(tokenize(a));
  const bb = bag(tokenize(b));
  if (ba.size === 0 || bb.size === 0) return 0;
  let dot = 0;
  for (const [t, av] of ba) {
    const bv = bb.get(t);
    if (bv) dot += av * bv;
  }
  const mag = (m: Map<string, number>) =>
    Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  return dot / (mag(ba) * mag(bb));
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface RankOptions {
  weights?: RankerWeights;
  topN?: number;
  now?: number;
}

export function rankCandidates(
  candidates: CandidateFact[],
  meeting: UpcomingMeeting,
  opts: RankOptions = {},
): RankedFact[] {
  const weights = opts.weights ?? RANKER_WEIGHTS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const now = opts.now ?? Date.now();

  const attendeeCount = Math.max(1, meeting.attendees.length);
  const agendaText = `${meeting.title} ${meeting.agenda ?? ""}`;
  const agendaEntities = new Set(
    tokenize(agendaText),
  );

  // Dedup by id and by normalized text — keep the first (sources are added in
  // priority order by the caller, so the strongest wins ties).
  const seenId = new Set<string>();
  const seenText = new Set<string>();

  const scored: RankedFact[] = [];
  for (const c of candidates) {
    const nt = normalizeText(c.text);
    if (seenId.has(c.id) || seenText.has(nt)) continue;
    seenId.add(c.id);
    seenText.add(nt);

    const recency = recencyDecay(c.timestamp, now);
    const overlap =
      Math.min(c.touchedBy?.length ?? 0, attendeeCount) / attendeeCount;
    const agenda = bowCosine(agendaText, `${c.text} ${c.entityIds.join(" ")}`);
    const prior = SOURCE_PRIOR[c.source];
    const explicit = c.entityIds.some((e) =>
      tokenize(e).some((tok) => agendaEntities.has(tok)),
    )
      ? 1
      : 0;

    const score =
      weights.w_recency * recency +
      weights.w_overlap * overlap +
      weights.w_agenda * agenda +
      weights.w_source_prior * prior +
      weights.w_explicit_ref * explicit;

    scored.push({ ...c, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
