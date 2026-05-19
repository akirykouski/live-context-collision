// Hot Loader.
//
// Maps the ranked top-N to the on-the-wire shapes and writes three Valkey
// keys: hot (MemoryFact[] — a true drop-in for retrieveRelevant()), vocab
// (AdditionalVocabEntry[] for Transcript Enhancer Layer 1) and the audit
// manifest. TTL on every key = (meeting.endMs - now)/1000 + 3600, min 300.
//
// Residency: before any write, reuse residency.ts. In strict + inconsistent
// mode we refuse rather than store data cross-region.

import { getValkey, hasValkey } from "@/lib/valkey";
import {
  assertResidency,
  getResidencyStatus,
} from "@/lib/residency";
import { prewarmKeys } from "@/lib/types";
import type { AdditionalVocabEntry, MemoryFact } from "@/lib/types";
import type {
  PrewarmManifest,
  RankedFact,
  SourceReport,
  UpcomingMeeting,
} from "./types";

const MIN_TTL_SEC = 300;
const TTL_PAD_SEC = 3600;

export function computeTtlSec(
  meeting: UpcomingMeeting,
  now: number = Date.now(),
): number {
  const ttl = Math.floor((meeting.endMs - now) / 1000) + TTL_PAD_SEC;
  return Math.max(MIN_TTL_SEC, ttl);
}

/**
 * Map a ranked candidate to a MemoryFact. Graph candidates already carry the
 * canonical fact — pass it through (without the score). Non-graph candidates
 * are synthesized into a reasonable MemoryFact so the specialists consume the
 * exact same shape. Score is NOT carried into the hot MemoryFact[].
 */
export function toMemoryFact(rf: RankedFact): MemoryFact {
  if (rf.memoryFact) {
    return { ...rf.memoryFact };
  }
  return {
    id: rf.id,
    type: "dependency",
    entity: rf.entityIds[0] ?? rf.source,
    related: rf.entityIds.slice(1),
    status: "active",
    source: `prewarm:${rf.source}`,
    statement: rf.text,
  };
}

/** Entity surface forms (+ optional sounds_like) for Layer 1. */
export function toVocab(ranked: RankedFact[]): AdditionalVocabEntry[] {
  const seen = new Set<string>();
  const out: AdditionalVocabEntry[] = [];
  for (const rf of ranked) {
    for (const e of rf.entityIds) {
      const content = e.trim();
      if (!content) continue;
      const key = content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ content });
    }
  }
  return out;
}

export interface HotLoadInput {
  meeting: UpcomingMeeting;
  ranked: RankedFact[];
  sources: SourceReport[];
  rankerInputCount: number;
  now?: number;
}

export interface HotLoadResult {
  manifest: PrewarmManifest;
  /** False when residency refused / Valkey unavailable (no-op, not a throw). */
  written: boolean;
}

async function setWithTtl(
  key: string,
  value: string,
  ttlSec: number,
): Promise<void> {
  const valkey = getValkey();
  await valkey.set(key, value);
  await valkey.expire(key, ttlSec);
}

export async function hotLoad(input: HotLoadInput): Promise<HotLoadResult> {
  const now = input.now ?? Date.now();
  const { meeting, ranked, sources } = input;

  // Residency guard — reuse, do not reinvent. Strict + inconsistent throws.
  assertResidency();
  const residency = getResidencyStatus();

  const facts = ranked.map(toMemoryFact);
  const vocab = toVocab(ranked);
  const hotJson = JSON.stringify(facts);
  const vocabJson = JSON.stringify(vocab);
  const ttlSec = computeTtlSec(meeting, now);

  const scores = ranked.map((r) => r.score);
  const manifest: PrewarmManifest = {
    meetingId: meeting.id,
    region: residency.dataZone,
    organizer: meeting.organizer,
    sources,
    ranker: {
      inputCount: input.rankerInputCount,
      outputCount: ranked.length,
      scoreMin: scores.length ? Math.min(...scores) : 0,
      scoreMax: scores.length ? Math.max(...scores) : 0,
    },
    hot: {
      ok: false,
      ttlSec,
      bytes: Buffer.byteLength(hotJson, "utf8"),
    },
    createdAt: now,
  };

  if (!hasValkey()) {
    return { manifest, written: false };
  }

  await setWithTtl(prewarmKeys.hot(meeting.id), hotJson, ttlSec);
  await setWithTtl(prewarmKeys.vocab(meeting.id), vocabJson, ttlSec);
  manifest.hot.ok = true;
  await setWithTtl(
    prewarmKeys.manifest(meeting.id),
    JSON.stringify(manifest),
    ttlSec,
  );

  return { manifest, written: true };
}
