// GitHub source.
//
// PRs / issues authored, reviewed, or commented on by attendees in the last
// 30 days, filtered to repos the organizer can see. The network client is an
// injectable interface so tests pass a mock and there is NO real network in
// Phase 1.

import type {
  CandidateFact,
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "../types";

export interface GitHubItem {
  /** "pr" | "issue". */
  kind: "pr" | "issue";
  number: number;
  repo: string;
  title: string;
  /** Attendee logins/emails who authored / reviewed / commented. */
  participants: string[];
  /** ISO string or epoch ms of last update. */
  updatedAt: string | number;
  url?: string;
}

export interface GitHubClient {
  /** Repos the meeting organizer can see (visibility filter). */
  visibleRepos(organizer: string): Promise<string[]>;
  /** Recent items touched by any of `logins` in the given repos. */
  recentItems(repos: string[], logins: string[]): Promise<GitHubItem[]>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(v);
}

export function makeGitHubSource(
  client: GitHubClient | null,
): PrewarmSourceAdapter {
  return {
    name: "github",
    async fetch(meeting: UpcomingMeeting): Promise<CandidateFact[]> {
      // No client injected → behave as an empty (not failing) source so the
      // scheduler records count:0 rather than an error.
      if (!client) return [];

      const now = Date.now();
      const logins = meeting.attendees.flatMap((a) =>
        [a.id, a.email].filter((v): v is string => !!v),
      );
      const repos = await client.visibleRepos(meeting.organizer);
      const items = await client.recentItems(repos, logins);
      const repoSet = new Set(repos);

      return items
        .filter((it) => repoSet.has(it.repo))
        .filter((it) => now - toMs(it.updatedAt) <= THIRTY_DAYS_MS)
        .filter((it) =>
          it.participants.some((p) =>
            logins.some((l) => l.toLowerCase() === p.toLowerCase()),
          ),
        )
        .map<CandidateFact>((it) => ({
          id: `github:${it.repo}#${it.number}`,
          source: "github",
          entityIds: [it.repo, it.title],
          text: `${it.kind === "pr" ? "PR" : "Issue"} ${it.repo}#${it.number}: ${it.title}`,
          timestamp: toMs(it.updatedAt),
          raw: it,
          touchedBy: it.participants,
        }));
    },
  };
}

/** Default adapter with no client wired — Phase 1 returns []. */
export const githubSource: PrewarmSourceAdapter = makeGitHubSource(null);
