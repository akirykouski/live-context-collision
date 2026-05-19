// Slack source — behind feature flag `prewarm.sources.slack`, default OFF.
//
// Privacy-sensitive (see spec 2.9): pulling DM / private-channel context into
// a meeting is high risk, so this returns [] unless the flag is explicitly
// enabled AND a client is injected.

import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

export interface SlackThread {
  channel: string;
  ts: string;
  text: string;
  participants: string[];
  postedAt: string | number;
}

export interface SlackClient {
  recentThreads(attendees: string[]): Promise<SlackThread[]>;
}

/** Flag gate. Default OFF — must be explicitly set to "true". */
export function slackEnabled(): boolean {
  return process.env.PREWARM_SOURCES_SLACK === "true";
}

function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(v);
}

export function makeSlackSource(
  client: SlackClient | null,
): PrewarmSourceAdapter {
  return {
    name: "slack",
    async fetch(meeting: UpcomingMeeting): Promise<CandidateFact[]> {
      if (!slackEnabled() || !client) return [];
      const attendees = meeting.attendees.flatMap((a) =>
        [a.id, a.email].filter((v): v is string => !!v),
      );
      const threads = await client.recentThreads(attendees);
      return threads.map<CandidateFact>((t) => ({
        id: `slack:${t.channel}:${t.ts}`,
        source: "slack",
        entityIds: [t.channel],
        text: `Slack #${t.channel}: ${t.text}`,
        timestamp: toMs(t.postedAt),
        raw: t,
        touchedBy: t.participants,
      }));
    },
  };
}

export const slackSource: PrewarmSourceAdapter = makeSlackSource(null);
