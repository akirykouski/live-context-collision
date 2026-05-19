// Jira / Linear source — Phase 2 placeholder.
//
// Shape is locked in now so the scheduler + ranker never change when Phase 2
// wires a real client. Returns [] unless a client is injected.

import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

export interface JiraIssue {
  key: string;
  summary: string;
  status?: string;
  priority?: string;
  sprint?: string;
  participants: string[];
  updatedAt: string | number;
}

export interface JiraClient {
  recentIssues(
    attendees: string[],
    organizer: string,
  ): Promise<JiraIssue[]>;
}

function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(v);
}

export function makeJiraSource(
  client: JiraClient | null,
): PrewarmSourceAdapter {
  return {
    name: "jira",
    async fetch(meeting: UpcomingMeeting): Promise<CandidateFact[]> {
      if (!client) return [];
      const attendees = meeting.attendees.flatMap((a) =>
        [a.id, a.email].filter((v): v is string => !!v),
      );
      const issues = await client.recentIssues(attendees, meeting.organizer);
      return issues.map<CandidateFact>((it) => ({
        id: `jira:${it.key}`,
        source: "jira",
        entityIds: [it.key, it.summary],
        text: `${it.key} [${it.status ?? "?"}/${it.priority ?? "?"}]: ${it.summary}`,
        timestamp: toMs(it.updatedAt),
        raw: it,
        touchedBy: it.participants,
      }));
    },
  };
}

export const jiraSource: PrewarmSourceAdapter = makeJiraSource(null);
