// Notion source — Phase 2 placeholder.
//
// Shape is locked in now. Returns [] unless a client is injected.

import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

export interface NotionPage {
  id: string;
  title: string;
  participants: string[];
  lastEditedAt: string | number;
  url?: string;
}

export interface NotionClient {
  recentPages(
    attendees: string[],
    organizer: string,
  ): Promise<NotionPage[]>;
}

function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(v);
}

export function makeNotionSource(
  client: NotionClient | null,
): PrewarmSourceAdapter {
  return {
    name: "notion",
    async fetch(meeting: UpcomingMeeting): Promise<CandidateFact[]> {
      if (!client) return [];
      const attendees = meeting.attendees.flatMap((a) =>
        [a.id, a.email].filter((v): v is string => !!v),
      );
      const pages = await client.recentPages(attendees, meeting.organizer);
      return pages.map<CandidateFact>((p) => ({
        id: `notion:${p.id}`,
        source: "notion",
        entityIds: [p.title],
        text: `Notion page: ${p.title}`,
        timestamp: toMs(p.lastEditedAt),
        raw: p,
        touchedBy: p.participants,
      }));
    },
  };
}

export const notionSource: PrewarmSourceAdapter = makeNotionSource(null);
