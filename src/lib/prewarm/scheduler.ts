// Scheduler.
//
// Every 60s (driven by a cron/route — swappable for webhooks in Phase 3) find
// meetings whose start is in [now+5min, now+15min] and that are not already
// prewarmed (idempotency marker), fan out the sources in parallel with a
// per-source 30s timeout + circuit breaker, rank, and hot-load.
//
// One source failing/timing out → partial prewarm still proceeds; the error
// is recorded in the manifest. Residency refusal skips the meeting (logged).

import meetingsFixture from "@/data/meetings.json";
import { getValkey, hasValkey } from "@/lib/valkey";
import { prewarmKeys } from "@/lib/types";
import type {
  CandidateFact,
  PrewarmJobResult,
  PrewarmSourceAdapter,
  SourceReport,
  UpcomingMeeting,
} from "./types";
import { calendarSource } from "./sources/calendar";
import { graphSource } from "./sources/graph";
import { githubSource } from "./sources/github";
import { jiraSource } from "./sources/jira";
import { notionSource } from "./sources/notion";
import { slackSource } from "./sources/slack";
import { rankCandidates } from "./ranker";
import { computeTtlSec, hotLoad } from "./hot-loader";

const ELIGIBLE_MIN_MS = 5 * 60 * 1000;
const ELIGIBLE_MAX_MS = 15 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 30_000;

/** Default fan-out, in ranker source-prior order (strongest first). */
export const DEFAULT_SOURCES: PrewarmSourceAdapter[] = [
  graphSource,
  calendarSource,
  githubSource,
  jiraSource,
  notionSource,
  slackSource,
];

/** Per-source circuit breaker: a source that threw last cycle is skipped this
 *  cycle. Simple in-module map, fine for the demo. */
const tripped = new Map<string, boolean>();

export function resetCircuitBreakers(): void {
  tripped.clear();
}

interface RawMeeting {
  id: string;
  title: string;
  startMs?: number;
  endMs?: number;
  startOffsetMin?: number;
  durationMin?: number;
  organizer: string;
  attendees: UpcomingMeeting["attendees"];
  agenda?: string;
  agendaDocUrl?: string;
  location?: string;
}

/**
 * Resolve fixture meetings to absolute times. The fixture uses
 * startOffsetMin / durationMin (relative to `now`) so it never goes stale;
 * explicit startMs/endMs (non-zero) win when present.
 */
export function loadMeetings(now: number = Date.now()): UpcomingMeeting[] {
  const raw = (meetingsFixture as { meetings: RawMeeting[] }).meetings;
  return raw.map((m) => {
    const startMs =
      m.startMs && m.startMs > 0
        ? m.startMs
        : now + (m.startOffsetMin ?? 0) * 60_000;
    const endMs =
      m.endMs && m.endMs > 0
        ? m.endMs
        : startMs + (m.durationMin ?? 30) * 60_000;
    return {
      id: m.id,
      title: m.title,
      startMs,
      endMs,
      organizer: m.organizer,
      attendees: m.attendees,
      agenda: m.agenda,
      agendaDocUrl: m.agendaDocUrl,
      location: m.location,
    };
  });
}

export function isEligible(
  meeting: UpcomingMeeting,
  now: number = Date.now(),
): boolean {
  const delta = meeting.startMs - now;
  return delta >= ELIGIBLE_MIN_MS && delta <= ELIGIBLE_MAX_MS;
}

async function alreadyPrewarmed(meetingId: string): Promise<boolean> {
  if (!hasValkey()) return false;
  try {
    return (await getValkey().exists(prewarmKeys.marker(meetingId))) === 1;
  } catch {
    return false;
  }
}

async function markPrewarmed(
  meeting: UpcomingMeeting,
  now: number,
): Promise<void> {
  if (!hasValkey()) return;
  const ttl = computeTtlSec(meeting, now);
  const v = getValkey();
  await v.set(prewarmKeys.marker(meeting.id), String(now));
  await v.expire(prewarmKeys.marker(meeting.id), ttl);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`source timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export interface PrewarmOneOptions {
  sources?: PrewarmSourceAdapter[];
  now?: number;
  /** Skip the idempotency marker check (manual force trigger). */
  force?: boolean;
}

export async function prewarmMeeting(
  meeting: UpcomingMeeting,
  opts: PrewarmOneOptions = {},
): Promise<PrewarmJobResult> {
  const now = opts.now ?? Date.now();
  const sources = opts.sources ?? DEFAULT_SOURCES;

  if (!opts.force && (await alreadyPrewarmed(meeting.id))) {
    return { meetingId: meeting.id, prewarmed: false, skippedReason: "already-prewarmed" };
  }

  const candidates: CandidateFact[] = [];
  const reports: SourceReport[] = [];

  for (const src of sources) {
    if (tripped.get(src.name)) {
      reports.push({ name: src.name, latencyMs: 0, count: 0, error: "circuit-open" });
      continue;
    }
    const started = now;
    try {
      const got = await withTimeout(src.fetch(meeting), SOURCE_TIMEOUT_MS);
      candidates.push(...got);
      reports.push({
        name: src.name,
        latencyMs: Date.now() - started,
        count: got.length,
      });
      tripped.set(src.name, false);
    } catch (err) {
      tripped.set(src.name, true);
      reports.push({
        name: src.name,
        latencyMs: Date.now() - started,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ranked = rankCandidates(candidates, meeting, { now });

  try {
    const { manifest } = await hotLoad({
      meeting,
      ranked,
      sources: reports,
      rankerInputCount: candidates.length,
      now,
    });
    await markPrewarmed(meeting, now);
    return { meetingId: meeting.id, prewarmed: true, manifest };
  } catch (err) {
    // Residency refusal (strict + inconsistent) or store failure → skip,
    // logged, no marker set so a later cycle can retry.
    console.warn(
      `[prewarm:${meeting.id}] hot-load refused/failed:`,
      err instanceof Error ? err.message : err,
    );
    return {
      meetingId: meeting.id,
      prewarmed: false,
      skippedReason:
        err instanceof Error ? err.message : "hot-load failed",
    };
  }
}

export interface RunSchedulerOptions extends PrewarmOneOptions {
  /** Override the meeting set (tests). Defaults to the fixture. */
  meetings?: UpcomingMeeting[];
}

/** One scheduler tick: prewarm every eligible, not-yet-warmed meeting. */
export async function runScheduler(
  opts: RunSchedulerOptions = {},
): Promise<PrewarmJobResult[]> {
  const now = opts.now ?? Date.now();
  const meetings = opts.meetings ?? loadMeetings(now);
  const eligible = meetings.filter((m) => isEligible(m, now));

  const results: PrewarmJobResult[] = [];
  for (const m of eligible) {
    results.push(await prewarmMeeting(m, { ...opts, now }));
  }
  return results;
}

/** Trigger a single meeting by id (manual/webhook). */
export async function prewarmMeetingById(
  meetingId: string,
  opts: PrewarmOneOptions = {},
): Promise<PrewarmJobResult> {
  const now = opts.now ?? Date.now();
  const meeting = loadMeetings(now).find((m) => m.id === meetingId);
  if (!meeting) {
    return {
      meetingId,
      prewarmed: false,
      skippedReason: "unknown-meeting",
    };
  }
  return prewarmMeeting(meeting, opts);
}
