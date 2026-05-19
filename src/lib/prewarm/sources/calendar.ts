// Calendar source.
//
// Phase 1: the meeting itself is the calendar payload. We surface the
// title / agenda / attendees as candidate facts (so an explicit agenda item
// can collide with a decision) and expose attendee-derived entity surface
// forms for the vocab key. A linked agenda doc is parsed only by URL host
// here (no network in Phase 1 / tests); deeper parsing is Phase 2.

import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

/** Split an agenda string into reasonably-sized clause candidates. */
function agendaClauses(agenda: string): string[] {
  return agenda
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

export function calendarCandidates(
  meeting: UpcomingMeeting,
  now: number = Date.now(),
): CandidateFact[] {
  const out: CandidateFact[] = [];
  const attendeeIds = meeting.attendees.map((a) => a.id);

  out.push({
    id: `calendar:${meeting.id}:title`,
    source: "calendar",
    entityIds: [meeting.title],
    text: `Meeting: ${meeting.title}`,
    timestamp: now,
    raw: { kind: "title", meetingId: meeting.id },
    touchedBy: attendeeIds,
  });

  if (meeting.agenda) {
    agendaClauses(meeting.agenda).forEach((clause, i) => {
      out.push({
        id: `calendar:${meeting.id}:agenda:${i}`,
        source: "calendar",
        entityIds: [meeting.title],
        text: `Agenda: ${clause}`,
        timestamp: now,
        raw: { kind: "agenda", meetingId: meeting.id, clause },
        touchedBy: attendeeIds,
      });
    });
  }

  if (meeting.agendaDocUrl) {
    let host = meeting.agendaDocUrl;
    try {
      host = new URL(meeting.agendaDocUrl).host;
    } catch {
      /* keep raw string */
    }
    out.push({
      id: `calendar:${meeting.id}:doc`,
      source: "calendar",
      entityIds: [meeting.title],
      text: `Linked agenda document on ${host}`,
      timestamp: now,
      raw: { kind: "agendaDoc", url: meeting.agendaDocUrl },
      touchedBy: attendeeIds,
    });
  }

  return out;
}

export const calendarSource: PrewarmSourceAdapter = {
  name: "calendar",
  async fetch(meeting: UpcomingMeeting) {
    return calendarCandidates(meeting);
  },
};
