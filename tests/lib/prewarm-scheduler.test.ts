import { describe, it, expect, beforeEach, vi } from "vitest";

const { store, valkeyState, fakeValkey } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const valkeyState = { available: true };
  const fakeValkey = {
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    },
    async expire() {
      return 1;
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
  };
  return { store, valkeyState, fakeValkey };
});

vi.mock("@/lib/valkey", () => ({
  hasValkey: () => valkeyState.available,
  getValkey: () => fakeValkey,
}));

import {
  isEligible,
  loadMeetings,
  prewarmMeeting,
  resetCircuitBreakers,
  runScheduler,
} from "@/lib/prewarm/scheduler";
import { prewarmKeys } from "@/lib/types";
import type {
  PrewarmSourceAdapter,
  UpcomingMeeting,
} from "@/lib/prewarm/types";

const NOW = 1_700_000_000_000;

function meeting(over: Partial<UpcomingMeeting> = {}): UpcomingMeeting {
  return {
    id: "m1",
    title: "Acme launch",
    startMs: NOW + 8 * 60_000,
    endMs: NOW + 38 * 60_000,
    organizer: "diego",
    attendees: [{ id: "diego" }, { id: "alex" }],
    agenda: "Acme launch by Friday",
    ...over,
  };
}

const okSource: PrewarmSourceAdapter = {
  name: "graph",
  async fetch() {
    return [
      {
        id: "f1",
        source: "graph",
        entityIds: ["Acme"],
        text: "Acme fact",
        timestamp: NOW,
        raw: {},
      },
    ];
  },
};

const throwingSource: PrewarmSourceAdapter = {
  name: "github",
  async fetch() {
    throw new Error("boom rate-limited");
  },
};

beforeEach(() => {
  store.clear();
  resetCircuitBreakers();
  valkeyState.available = true;
  delete process.env.WORKGRAPH_RESIDENCY_STRICT;
});

describe("isEligible (fake clock via injected now)", () => {
  it("T-8min eligible, T-20min and T-3min not", () => {
    expect(isEligible(meeting({ startMs: NOW + 8 * 60_000 }), NOW)).toBe(true);
    expect(isEligible(meeting({ startMs: NOW + 20 * 60_000 }), NOW)).toBe(
      false,
    );
    expect(isEligible(meeting({ startMs: NOW + 3 * 60_000 }), NOW)).toBe(false);
  });
});

describe("loadMeetings", () => {
  it("resolves the fixture relative to now and keeps it upcoming", () => {
    const ms = loadMeetings(NOW);
    expect(ms.length).toBeGreaterThanOrEqual(2);
    const acme = ms.find((m) => m.id === "acme-launch-sync")!;
    expect(acme.startMs).toBeGreaterThan(NOW);
    expect(acme.endMs).toBeGreaterThan(acme.startMs);
  });
});

describe("prewarmMeeting", () => {
  it("prewarms, sets the marker, and is skipped on the second pass", async () => {
    const r1 = await prewarmMeeting(meeting(), {
      sources: [okSource],
      now: NOW,
    });
    expect(r1.prewarmed).toBe(true);
    expect(store.has(prewarmKeys.hot("m1"))).toBe(true);
    expect(store.has(prewarmKeys.marker("m1"))).toBe(true);

    const r2 = await prewarmMeeting(meeting(), {
      sources: [okSource],
      now: NOW,
    });
    expect(r2.prewarmed).toBe(false);
    expect(r2.skippedReason).toBe("already-prewarmed");
  });

  it("partial prewarm proceeds when one source throws; manifest records the error", async () => {
    const r = await prewarmMeeting(meeting(), {
      sources: [okSource, throwingSource],
      now: NOW,
    });
    expect(r.prewarmed).toBe(true);
    const gh = r.manifest!.sources.find((s) => s.name === "github")!;
    expect(gh.error).toMatch(/boom rate-limited/);
    expect(r.manifest!.sources.find((s) => s.name === "graph")!.count).toBe(1);
  });

  it("circuit breaker skips a source that threw last cycle", async () => {
    await prewarmMeeting(meeting({ id: "ma" }), {
      sources: [throwingSource],
      now: NOW,
    });
    const r = await prewarmMeeting(meeting({ id: "mb" }), {
      sources: [throwingSource],
      now: NOW,
    });
    const gh = r.manifest!.sources.find((s) => s.name === "github")!;
    expect(gh.error).toBe("circuit-open");
  });

  it("residency strict+inconsistent → not prewarmed, no marker", async () => {
    process.env.WORKGRAPH_DATA_ZONE = "us";
    process.env.WORKGRAPH_RESIDENCY_STRICT = "true";
    const r = await prewarmMeeting(meeting({ id: "mr" }), {
      sources: [okSource],
      now: NOW,
    });
    expect(r.prewarmed).toBe(false);
    expect(store.has(prewarmKeys.marker("mr"))).toBe(false);
    delete process.env.WORKGRAPH_DATA_ZONE;
  });
});

describe("runScheduler", () => {
  it("only prewarms eligible meetings", async () => {
    const results = await runScheduler({
      sources: [okSource],
      now: NOW,
      meetings: [
        meeting({ id: "soon", startMs: NOW + 8 * 60_000 }),
        meeting({ id: "far", startMs: NOW + 40 * 60_000 }),
      ],
    });
    expect(results.map((r) => r.meetingId)).toEqual(["soon"]);
    expect(results[0].prewarmed).toBe(true);
  });
});
