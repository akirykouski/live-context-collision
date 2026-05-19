// Layer 1 — Speechmatics custom dictionary. The highest-ROI layer: push known
// vocabulary into the ASR *before* recognition, so entity names come back
// correct and Layers 2/3 have less to repair. Zero LLM calls, zero latency on
// the hot path. Never throws — a dictionary failure must never block the
// token mint or the meeting.

import people from "@/data/people.json";
import memory from "@/data/memory.json";
import type { MemoryFact, Person } from "@/lib/types";
import type { AdditionalVocabEntry } from "@/lib/types";
import { prewarmKeys } from "@/lib/types";
import { getValkey, hasValkey } from "@/lib/valkey";

/**
 * Speechmatics caps `additional_vocab` per session. We rank by relevance and
 * truncate to this many entries; overflow is logged, not fatal.
 */
export const VOCAB_CAP = 1000;

const PEOPLE = (people as { people: Person[] }).people;
const MEMORY_FACTS = (memory as { facts: MemoryFact[] }).facts;

/** True for names with non-ASCII characters (need an ASCII phonetic hint). */
function needsSoundsLike(name: string): boolean {
  for (const ch of name) {
    if (ch.codePointAt(0)! > 127) return true;
  }
  return false;
}

/**
 * Best-effort phonetic hint for a display name. We only add a hint when the
 * surface form is non-ASCII (Speechmatics biases better with an ASCII
 * approximation) -- a deterministic transliteration that strips diacritics
 * and drops any remaining non-ASCII code points.
 */
function soundsLikeFor(name: string): string[] | undefined {
  if (!needsSoundsLike(name)) return undefined;
  const decomposed = name.normalize("NFKD");
  let ascii = "";
  for (const ch of decomposed) {
    const cp = ch.codePointAt(0)!;
    // 0x300-0x36F = combining diacritical marks; drop them and any non-ASCII.
    if (cp >= 0x300 && cp <= 0x36f) continue;
    if (cp <= 127) ascii += ch;
  }
  ascii = ascii.trim();
  return ascii.length > 0 && ascii.toLowerCase() !== name.toLowerCase()
    ? [ascii]
    : undefined;
}

interface RankedEntry {
  entry: AdditionalVocabEntry;
  /** Higher = more likely to be said in this meeting. */
  rank: number;
}

function pushEntry(
  acc: Map<string, RankedEntry>,
  content: string,
  rank: number,
  soundsLike?: string[],
): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) return;
  const key = trimmed.toLowerCase();
  const existing = acc.get(key);
  if (existing) {
    // Keep the highest rank seen; merge phonetic hints.
    if (rank > existing.rank) existing.rank = rank;
    if (soundsLike && soundsLike.length > 0) {
      const merged = new Set([
        ...(existing.entry.sounds_like ?? []),
        ...soundsLike,
      ]);
      existing.entry.sounds_like = [...merged];
    }
    return;
  }
  acc.set(key, {
    entry: soundsLike ? { content: trimmed, sounds_like: soundsLike } : { content: trimmed },
    rank,
  });
}

/**
 * Read the per-meeting prewarm vocab the Pre-Warmer wrote to Valkey. This is
 * the cross-feature integration point: `prewarmKeys.vocab(meetingId)` holds a
 * JSON-encoded {@link AdditionalVocabEntry}[]. Absent key / parse failure /
 * Valkey down → empty (graceful, never throws).
 */
async function readPrewarmVocab(
  meetingId: string,
): Promise<AdditionalVocabEntry[]> {
  if (!hasValkey()) return [];
  try {
    const raw = await getValkey().get(prewarmKeys.vocab(meetingId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is AdditionalVocabEntry =>
        !!e && typeof (e as AdditionalVocabEntry).content === "string",
    );
  } catch (err) {
    console.warn(
      "[dictionary-builder] prewarm vocab read failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export interface BuildVocabOptions {
  /** When set AND Valkey is configured, merge the prewarm vocab key. */
  meetingId?: string;
  /** Override the cap (testing). */
  cap?: number;
}

/**
 * Build the ranked, deduped, capped `additional_vocab` payload.
 *
 * Sources, in descending base rank:
 *   3.0  prewarm vocab (Feature 2 already scored these for *this* meeting)
 *   2.0  attendee display names (+ phonetic sounds_like for non-ASCII)
 *   1.0  memory-graph entities + related terms
 *
 * Dedupe is by lowercased content. Overflow past the cap is logged.
 * Guaranteed: never throws; returns at worst [].
 */
export async function buildAdditionalVocab(
  opts: BuildVocabOptions = {},
): Promise<AdditionalVocabEntry[]> {
  const cap = opts.cap ?? VOCAB_CAP;
  const acc = new Map<string, RankedEntry>();

  try {
    // (a) attendee display names
    for (const p of PEOPLE) {
      pushEntry(acc, p.name, 2.0, soundsLikeFor(p.name));
    }

    // (b) memory entities + related terms
    for (const f of MEMORY_FACTS) {
      pushEntry(acc, f.entity, 1.0 + (f.severity === "high" ? 0.3 : 0));
      for (const r of f.related ?? []) pushEntry(acc, r, 1.0);
      for (const p of f.activeP0s ?? []) pushEntry(acc, p, 1.0);
    }

    // (c) prewarm vocab — highest rank, already meeting-scored upstream.
    if (opts.meetingId) {
      const prewarm = await readPrewarmVocab(opts.meetingId);
      for (const e of prewarm) {
        pushEntry(acc, e.content, 3.0, e.sounds_like);
      }
    }
  } catch (err) {
    // Builder must be total. Whatever we accumulated so far still ships.
    console.warn(
      "[dictionary-builder] vocab build degraded:",
      err instanceof Error ? err.message : err,
    );
  }

  const ranked = [...acc.values()].sort(
    (a, b) =>
      b.rank - a.rank ||
      a.entry.content.toLowerCase().localeCompare(b.entry.content.toLowerCase()),
  );

  if (ranked.length > cap) {
    console.warn(
      `[dictionary-builder] vocab overflow: ${ranked.length} entries, ` +
        `truncating to cap ${cap} (dropping ${ranked.length - cap})`,
    );
  }

  return ranked.slice(0, cap).map((r) => r.entry);
}

export const __test__ = { soundsLikeFor, needsSoundsLike, readPrewarmVocab };
