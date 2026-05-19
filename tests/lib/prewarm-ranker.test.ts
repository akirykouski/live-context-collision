import { describe, it, expect } from "vitest";
import {
  RANKER_WEIGHTS,
  SOURCE_PRIOR,
  bowCosine,
  rankCandidates,
  recencyDecay,
} from "@/lib/prewarm/ranker";
import type { CandidateFact, UpcomingMeeting } from "@/lib/prewarm/types";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const meeting: UpcomingMeeting = {
  id: "m1",
  title: "Acme launch readiness",
  startMs: NOW + 8 * 60_000,
  endMs: NOW + 38 * 60_000,
  organizer: "diego",
  attendees: [
    { id: "diego" },
    { id: "alex" },
    { id: "sam" },
    { id: "valya" },
  ],
  agenda: "Confirm Acme launch by Friday and review SSO Auth Refactor status.",
};

function cand(over: Partial<CandidateFact>): CandidateFact {
  return {
    id: `c-${Math.random()}`,
    source: "graph",
    entityIds: ["misc"],
    text: "something unrelated",
    timestamp: NOW - 14 * DAY,
    raw: {},
    ...over,
  };
}

describe("recencyDecay", () => {
  it("is 1 at t=now and 0.5 at one half-life (7d)", () => {
    expect(recencyDecay(NOW, NOW)).toBeCloseTo(1, 6);
    expect(recencyDecay(NOW - 7 * DAY, NOW)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(NOW - 14 * DAY, NOW)).toBeCloseTo(0.25, 6);
  });
});

describe("bowCosine", () => {
  it("is 1 for identical bags, 0 for disjoint", () => {
    expect(bowCosine("acme launch", "launch acme")).toBeCloseTo(1, 6);
    expect(bowCosine("acme launch", "zzz qqq")).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("orders by the spec formula — golden top-k", () => {
    const explicitAgenda = cand({
      id: "agenda-acme",
      source: "graph",
      entityIds: ["Acme", "launch"],
      text: "Acme launch is gated by SSO Auth Refactor",
      timestamp: NOW,
      touchedBy: ["diego", "alex", "sam", "valya"],
    });
    const recentGithub = cand({
      id: "gh-1",
      source: "github",
      entityIds: ["repo/sso"],
      text: "PR repo/sso#9: auth refactor wip",
      timestamp: NOW - DAY,
      touchedBy: ["sam"],
    });
    const staleSlack = cand({
      id: "sl-1",
      source: "slack",
      entityIds: ["random"],
      text: "lunch plans thread",
      timestamp: NOW - 30 * DAY,
      touchedBy: [],
    });

    const ranked = rankCandidates(
      [staleSlack, recentGithub, explicitAgenda],
      meeting,
      { now: NOW },
    );
    expect(ranked.map((r) => r.id)).toEqual([
      "agenda-acme",
      "gh-1",
      "sl-1",
    ]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("honors w_explicit_ref — bumping it lifts the agenda-entity fact", () => {
    const agendaEntity = cand({
      id: "explicit",
      source: "slack", // weak prior on purpose
      entityIds: ["Acme"],
      text: "zzz", // no agenda token overlap in text
      timestamp: NOW - 60 * DAY, // old
      touchedBy: [],
    });
    const strongOther = cand({
      id: "other",
      source: "graph",
      entityIds: ["unrelated"],
      text: "unrelated",
      timestamp: NOW,
      touchedBy: ["diego", "alex", "sam", "valya"],
    });

    // With explicit-ref disabled, the strong recent/overlap fact wins.
    const off = rankCandidates([agendaEntity, strongOther], meeting, {
      now: NOW,
      weights: { ...RANKER_WEIGHTS, w_explicit_ref: 0 },
    });
    expect(off[0].id).toBe("other");

    // Bumping w_explicit_ref lifts the agenda-entity fact above it.
    const bumped = rankCandidates([agendaEntity, strongOther], meeting, {
      now: NOW,
      weights: { ...RANKER_WEIGHTS, w_explicit_ref: 50 },
    });
    expect(bumped[0].id).toBe("explicit");
  });

  it("dedupes by id and by normalized text, and caps at topN", () => {
    const a = cand({ id: "dup", text: "Same Thing" });
    const b = cand({ id: "dup", text: "different" });
    const c = cand({ id: "other", text: "  same   thing " });
    const ranked = rankCandidates([a, b, c], meeting, { now: NOW });
    expect(ranked).toHaveLength(1);

    const many = Array.from({ length: 10 }, (_, i) =>
      cand({ id: `x${i}`, text: `t${i}` }),
    );
    expect(rankCandidates(many, meeting, { now: NOW, topN: 3 })).toHaveLength(
      3,
    );
  });

  it("source priors are graph > github > jira > notion > slack", () => {
    expect(SOURCE_PRIOR.graph).toBeGreaterThan(SOURCE_PRIOR.github);
    expect(SOURCE_PRIOR.github).toBeGreaterThan(SOURCE_PRIOR.jira);
    expect(SOURCE_PRIOR.jira).toBeGreaterThan(SOURCE_PRIOR.notion);
    expect(SOURCE_PRIOR.notion).toBeGreaterThan(SOURCE_PRIOR.slack);
  });
});
