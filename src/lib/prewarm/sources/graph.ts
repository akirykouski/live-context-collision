// Memory-graph source — the cheapest and most reliable.
//
// Pulls existing canonical facts whose entity / related / activeP0s overlap an
// attendee, the agenda text, or a person this meeting is about. Each candidate
// carries the original MemoryFact so the hot-loader passes it through unchanged
// (graph facts are already the on-the-wire shape).

import { allFacts } from "@/lib/memory";
import type { MemoryFact } from "@/lib/types";
import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function factTerms(f: MemoryFact): string {
  return [
    f.entity,
    ...(f.related ?? []),
    ...(f.activeP0s ?? []),
    f.statement,
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Approximate a fact's last-touched time. The seed graph has no timestamps;
 * the ranker's recency decay still works (all seed facts share the same
 * baseline) and learned facts written this meeting are treated as "now".
 */
function factTimestamp(f: MemoryFact, now: number): number {
  return f.id.startsWith("learned-") ? now : now - 3 * 24 * 60 * 60 * 1000;
}

export function graphCandidates(
  meeting: UpcomingMeeting,
  now: number = Date.now(),
): CandidateFact[] {
  const facts = allFacts();

  const attendeeKeys = meeting.attendees.flatMap((a) =>
    [a.id, a.name, a.email].filter((v): v is string => !!v).map((v) => v.toLowerCase()),
  );
  const agendaTokens = new Set(tokens(`${meeting.title} ${meeting.agenda ?? ""}`));

  const out: CandidateFact[] = [];
  for (const f of facts) {
    if (f.status === "expired") continue;
    const terms = factTerms(f);

    const attendeeHit = attendeeKeys.some((k) => terms.includes(k));
    const agendaHit = [...agendaTokens].some((t) => terms.includes(t));
    if (!attendeeHit && !agendaHit) continue;

    out.push({
      id: f.id,
      source: "graph",
      entityIds: [f.entity, ...(f.related ?? [])],
      text: f.statement,
      timestamp: factTimestamp(f, now),
      raw: f,
      touchedBy: meeting.attendees
        .filter((a) =>
          [a.id, a.name, a.email]
            .filter((v): v is string => !!v)
            .some((v) => terms.includes(v.toLowerCase())),
        )
        .map((a) => a.id),
      memoryFact: f,
    });
  }
  return out;
}

export const graphSource: PrewarmSourceAdapter = {
  name: "graph",
  async fetch(meeting: UpcomingMeeting) {
    return graphCandidates(meeting);
  },
};
