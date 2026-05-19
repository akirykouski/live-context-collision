import { describe, it, expect, beforeEach } from "vitest";
import { calendarCandidates } from "@/lib/prewarm/sources/calendar";
import { graphCandidates } from "@/lib/prewarm/sources/graph";
import {
  makeGitHubSource,
  type GitHubClient,
  type GitHubItem,
} from "@/lib/prewarm/sources/github";
import { makeJiraSource } from "@/lib/prewarm/sources/jira";
import { makeNotionSource } from "@/lib/prewarm/sources/notion";
import { makeSlackSource } from "@/lib/prewarm/sources/slack";
import type { UpcomingMeeting } from "@/lib/prewarm/types";

const NOW = Date.now();

const meeting: UpcomingMeeting = {
  id: "acme-launch-sync",
  title: "Acme launch readiness sync",
  startMs: NOW + 8 * 60_000,
  endMs: NOW + 38 * 60_000,
  organizer: "diego",
  attendees: [
    { id: "diego", email: "diego@x.dev", name: "Diego" },
    { id: "alex", email: "alex@x.dev", name: "Alex" },
    { id: "sam", email: "sam@x.dev", name: "Sam" },
    { id: "valya", email: "valya@x.dev", name: "Valya" },
  ],
  agenda: "Confirm Acme launch by Friday. Review SSO and Auth Refactor.",
  agendaDocUrl: "https://docs.internal/acme-launch",
};

describe("calendar source", () => {
  it("emits title + agenda clauses + doc with CandidateFact shape", () => {
    const out = calendarCandidates(meeting, NOW);
    const ids = out.map((c) => c.id);
    expect(ids).toContain("calendar:acme-launch-sync:title");
    expect(ids).toContain("calendar:acme-launch-sync:doc");
    expect(ids.some((i) => i.startsWith("calendar:acme-launch-sync:agenda:"))).toBe(
      true,
    );
    for (const c of out) {
      expect(c.source).toBe("calendar");
      expect(Array.isArray(c.entityIds)).toBe(true);
      expect(typeof c.text).toBe("string");
      expect(typeof c.timestamp).toBe("number");
      expect(c.touchedBy).toEqual(["diego", "alex", "sam", "valya"]);
    }
  });
});

describe("graph source", () => {
  it("maps memory.json facts that overlap attendees/agenda and carries memoryFact", () => {
    const out = graphCandidates(meeting, NOW);
    const ids = out.map((c) => c.id);
    expect(ids).toContain("commitment-acme"); // Acme in agenda
    expect(ids).toContain("capacity-valya"); // attendee Valya
    expect(ids).toContain("decision-acme-export"); // Acme
    for (const c of out) {
      expect(c.source).toBe("graph");
      expect(c.memoryFact).toBeDefined();
      expect(c.memoryFact?.id).toBe(c.id);
      expect(c.text).toBe(c.memoryFact?.statement);
    }
  });

  it("excludes facts with no attendee/agenda overlap", () => {
    const m: UpcomingMeeting = {
      ...meeting,
      title: "Quarterly offsite",
      agenda: "team building exercises and lunch",
      attendees: [{ id: "nobody", name: "Nobody" }],
    };
    expect(graphCandidates(m, NOW)).toHaveLength(0);
  });
});

describe("github source (mocked client, no network)", () => {
  const recent = NOW - 5 * 24 * 60 * 60 * 1000;
  const old = NOW - 45 * 24 * 60 * 60 * 1000;
  const items: GitHubItem[] = [
    {
      kind: "pr",
      number: 12,
      repo: "org/app",
      title: "SSO wiring",
      participants: ["sam"],
      updatedAt: recent,
    },
    {
      kind: "issue",
      number: 99,
      repo: "org/app",
      title: "ancient",
      participants: ["sam"],
      updatedAt: old,
    },
    {
      kind: "pr",
      number: 7,
      repo: "org/secret",
      title: "not visible",
      participants: ["sam"],
      updatedAt: recent,
    },
    {
      kind: "pr",
      number: 3,
      repo: "org/app",
      title: "by stranger",
      participants: ["stranger"],
      updatedAt: recent,
    },
  ];
  const client: GitHubClient = {
    async visibleRepos() {
      return ["org/app"];
    },
    async recentItems() {
      return items;
    },
  };

  it("filters by repo visibility, 30d window, and attendee participation", async () => {
    const out = await makeGitHubSource(client).fetch(meeting);
    expect(out.map((c) => c.id)).toEqual(["github:org/app#12"]);
    expect(out[0].source).toBe("github");
  });

  it("returns [] (not error) when no client injected", async () => {
    expect(await makeGitHubSource(null).fetch(meeting)).toEqual([]);
  });
});

describe("stub sources are shaped no-ops without a client", () => {
  it("jira/notion/slack return [] with no client", async () => {
    expect(await makeJiraSource(null).fetch(meeting)).toEqual([]);
    expect(await makeNotionSource(null).fetch(meeting)).toEqual([]);
    expect(await makeSlackSource(null).fetch(meeting)).toEqual([]);
  });

  it("slack stays off even with a client unless flag enabled", async () => {
    const client = {
      async recentThreads() {
        return [
          {
            channel: "general",
            ts: "1",
            text: "hi",
            participants: ["sam"],
            postedAt: NOW,
          },
        ];
      },
    };
    delete process.env.PREWARM_SOURCES_SLACK;
    expect(await makeSlackSource(client).fetch(meeting)).toEqual([]);
    process.env.PREWARM_SOURCES_SLACK = "true";
    const out = await makeSlackSource(client).fetch(meeting);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("slack");
    delete process.env.PREWARM_SOURCES_SLACK;
  });
});
